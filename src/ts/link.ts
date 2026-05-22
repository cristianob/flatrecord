import type { LineString } from 'geojson';
import { columnMeta, inferColumnType, type ColumnMeta } from './column-meta.js';
import { SIZE_PREFIX_LEN } from './constants.js';
import { ColumnType } from './fbs/column-type.js';
import type {
    AdjacencyListInput,
    Link,
    LinkInput,
    LinkProperties,
} from './link-types.js';
import { DEFAULT_NODE_SIZE, type Rect } from './packedrtree.js';
import { buildPackedRTree, envelopeOf, hilbertPermutation, type IndexItem } from './packedrtree-writer.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Infer column types from the first link that has properties. */
export function introspectLinkColumns(links: LinkInput[]): ColumnMeta[] | null {
    const firstWithProps = links.find((l) => l.properties && Object.keys(l.properties).length > 0);
    if (!firstWithProps?.properties) return null;
    return Object.keys(firstWithProps.properties).map((name) =>
        columnMeta(name, inferColumnType(firstWithProps.properties![name])),
    );
}

function encodeLinkProperties(properties: LinkProperties | undefined, columns: ColumnMeta[] | null): Uint8Array {
    if (!columns || columns.length === 0 || !properties) {
        return new Uint8Array(0);
    }

    let offset = 0;
    let capacity = 256;
    let bytes = new Uint8Array(capacity);
    let view = new DataView(bytes.buffer);

    const prep = (size: number) => {
        if (offset + size < capacity) return;
        capacity = Math.max(capacity + size, capacity * 2);
        const newBytes = new Uint8Array(capacity);
        newBytes.set(bytes);
        bytes = newBytes;
        view = new DataView(bytes.buffer);
    };

    for (let i = 0; i < columns.length; i++) {
        const column = columns[i];
        const value = properties[column.name];
        if (value === null || value === undefined) continue;

        prep(2);
        view.setUint16(offset, i, true);
        offset += 2;

        switch (column.type) {
            case ColumnType.Bool:
                prep(1);
                view.setUint8(offset, value ? 1 : 0);
                offset += 1;
                break;
            case ColumnType.Short:
                prep(2);
                view.setInt16(offset, value as number, true);
                offset += 2;
                break;
            case ColumnType.UShort:
                prep(2);
                view.setUint16(offset, value as number, true);
                offset += 2;
                break;
            case ColumnType.Int:
                prep(4);
                view.setInt32(offset, value as number, true);
                offset += 4;
                break;
            case ColumnType.UInt:
                prep(4);
                view.setUint32(offset, value as number, true);
                offset += 4;
                break;
            case ColumnType.Long:
                prep(8);
                view.setBigInt64(offset, BigInt(value as number), true);
                offset += 8;
                break;
            case ColumnType.Float:
                prep(4);
                view.setFloat32(offset, value as number, true);
                offset += 4;
                break;
            case ColumnType.Double:
                prep(8);
                view.setFloat64(offset, value as number, true);
                offset += 8;
                break;
            case ColumnType.DateTime:
            case ColumnType.String: {
                const str = textEncoder.encode(value as string);
                prep(4 + str.length);
                view.setUint32(offset, str.length, true);
                offset += 4;
                bytes.set(str, offset);
                offset += str.length;
                break;
            }
            case ColumnType.Json: {
                const str = textEncoder.encode(JSON.stringify(value));
                prep(4 + str.length);
                view.setUint32(offset, str.length, true);
                offset += 4;
                bytes.set(str, offset);
                offset += str.length;
                break;
            }
            case ColumnType.Binary: {
                const blob = value as Uint8Array;
                prep(4 + blob.length);
                view.setUint32(offset, blob.length, true);
                offset += 4;
                bytes.set(blob, offset);
                offset += blob.length;
                break;
            }
            default:
                throw new Error(`Unknown column type: ${column.type}`);
        }
    }

    return bytes.slice(0, offset);
}

function validateLinkGeometry(geometry: LineString | null | undefined): LineString | null {
    if (!geometry) return null;
    if (geometry.type !== 'LineString') {
        throw new Error(`Link geometry must be LineString, got: ${(geometry as { type: string }).type}`);
    }
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
        throw new Error('Link LineString must have at least 2 coordinates');
    }
    return geometry;
}

function encodeLinkGeometry(geometry: LineString | null): Uint8Array {
    if (!geometry) {
        const buf = new Uint8Array(4);
        return buf;
    }
    const coords = geometry.coordinates;
    const pointCount = coords.length;
    const buf = new Uint8Array(4 + pointCount * 16);
    const view = new DataView(buf.buffer);
    view.setUint32(0, pointCount, true);
    let offset = 4;
    for (let i = 0; i < pointCount; i++) {
        const c = coords[i];
        view.setFloat64(offset, c[0], true);
        offset += 8;
        view.setFloat64(offset, c[1], true);
        offset += 8;
    }
    return buf;
}

/** Encode one link record (size-prefixed) as bytes. */
export function buildLinkRecord(link: LinkInput, columns: ColumnMeta[] | null, featureCount: number): Uint8Array {
    if (link.from < 0 || link.from >= featureCount) {
        throw new Error(`Invalid 'from' index: ${link.from}. Must be between 0 and ${featureCount - 1}`);
    }
    if (link.to < 0 || link.to >= featureCount) {
        throw new Error(`Invalid 'to' index: ${link.to}. Must be between 0 and ${featureCount - 1}`);
    }
    if (link.from === link.to) {
        throw new Error(`Self-loops are not allowed: from=${link.from}, to=${link.to}`);
    }

    const geometry = validateLinkGeometry(link.geometry);
    const geomBytes = encodeLinkGeometry(geometry);
    const propsBytes = encodeLinkProperties(link.properties, columns);
    const size = 8 + geomBytes.length + propsBytes.length;
    const result = new Uint8Array(SIZE_PREFIX_LEN + size);
    const view = new DataView(result.buffer);

    view.setUint32(0, size, true);
    view.setUint32(4, link.from, true);
    view.setUint32(8, link.to, true);
    result.set(geomBytes, 12);
    result.set(propsBytes, 12 + geomBytes.length);

    return result;
}

function linkBbox(link: LinkInput, featureBboxes: Rect[] | undefined): Rect {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    if (link.geometry && link.geometry.coordinates.length > 0) {
        for (const c of link.geometry.coordinates) {
            if (c[0] < minX) minX = c[0];
            if (c[1] < minY) minY = c[1];
            if (c[0] > maxX) maxX = c[0];
            if (c[1] > maxY) maxY = c[1];
        }
    }
    if (featureBboxes) {
        const fb = featureBboxes[link.from];
        const tb = featureBboxes[link.to];
        if (fb.minX < minX) minX = fb.minX;
        if (fb.minY < minY) minY = fb.minY;
        if (fb.maxX > maxX) maxX = fb.maxX;
        if (fb.maxY > maxY) maxY = fb.maxY;
        if (tb.minX < minX) minX = tb.minX;
        if (tb.minY < minY) minY = tb.minY;
        if (tb.maxX > maxX) maxX = tb.maxX;
        if (tb.maxY > maxY) maxY = tb.maxY;
    }

    if (!Number.isFinite(minX)) {
        // Should not happen: `buildLinkBlocks` skips the link R-tree
        // when bbox info is unavailable. Defensive throw for the case
        // someone calls `linkBbox` directly.
        throw new Error(
            'Cannot compute link bbox: link has no geometry and feature bboxes were not provided.',
        );
    }
    return { minX, minY, maxX, maxY };
}

/** Build the link-adjacency CSR offsets block.
 *
 *  `links` must already be sorted by `from` ascending so each
 *  feature's outgoing-link span is a contiguous byte range inside the
 *  links payload. Returns the raw block (4 bytes per offset, N+1
 *  entries), with no size prefix — the file directory carries the
 *  length.
 */
export function buildLinkAdjacencyBlock(
    sortedLinks: LinkInput[],
    linkLengths: number[],
    featureCount: number,
): Uint8Array {
    const numOffsets = featureCount + 1;
    const buf = new Uint8Array(4 * numOffsets);
    const view = new DataView(buf.buffer);

    const offsets = new Uint32Array(numOffsets);
    let cursor = 0;
    let linkIdx = 0;
    for (let v = 0; v < featureCount; v++) {
        offsets[v] = cursor;
        while (linkIdx < sortedLinks.length && sortedLinks[linkIdx].from === v) {
            cursor += linkLengths[linkIdx];
            linkIdx++;
        }
    }
    offsets[featureCount] = cursor;

    for (let v = 0; v <= featureCount; v++) {
        view.setUint32(v * 4, offsets[v], true);
    }
    return buf;
}

/** Build the link spatial-index (packed Hilbert R-tree) block. */
export function buildLinkSpatialIndexBlock(
    links: LinkInput[],
    linkByteOffsets: number[],
    featureBboxes: Rect[] | undefined,
): Uint8Array {
    const bboxes = links.map((l) => linkBbox(l, featureBboxes));
    const envelope = envelopeOf(bboxes);
    const perm = hilbertPermutation(bboxes, envelope);
    const items: IndexItem[] = perm.map((oldIdx) => ({
        ...bboxes[oldIdx],
        offset: linkByteOffsets[oldIdx],
    }));
    return buildPackedRTree(items, DEFAULT_NODE_SIZE);
}

export interface BuildLinkBlocksResult {
    /** Links payload (concatenated size-prefixed link records). */
    linksBlock: Uint8Array;
    /** CSR adjacency block (4×(N+1) bytes) or null. */
    adjacencyBlock: Uint8Array | null;
    /** Link spatial index (R-tree raw bytes) or null. */
    spatialIndexBlock: Uint8Array | null;
    /** Link column schema inferred from the first link with properties. */
    linkColumns: ColumnMeta[] | null;
    /** Ordered link records used to compute the property index. The
     *  property index, when present, indexes record positions inside
     *  the links payload — these positions match `orderedLinks`. */
    orderedLinks: LinkInput[];
    /** Per-link sizes (bytes) in the same order as `orderedLinks`.
     *  Used by callers (e.g. the reverse adjacency builder) that need
     *  to map storage-ordered indices to byte offsets in the payload. */
    linkSizes: number[];
}

export function buildLinkBlocks(
    adjacency: AdjacencyListInput,
    featureCount: number,
    options: {
        writeAdjacencyIndex: boolean;
        writeSpatialIndex: boolean;
        featureBboxes?: Rect[];
        /** Optional explicit link column schema. When omitted the
         *  writer infers from the first link with properties. */
        linkColumns?: ColumnMeta[] | null;
    },
): BuildLinkBlocksResult {
    const writeAdj = options.writeAdjacencyIndex;
    const writeRTree = options.writeSpatialIndex;

    const orderedLinks = writeAdj
        ? [...adjacency.links].sort((a, b) => a.from - b.from)
        : adjacency.links;

    const linkColumns = options.linkColumns ?? introspectLinkColumns(orderedLinks);
    const linkBuffers = orderedLinks.map((l) => buildLinkRecord(l, linkColumns, featureCount));
    const linkLengths = linkBuffers.map((b) => b.length);

    let cursor = 0;
    const linkByteOffsets: number[] = new Array(orderedLinks.length);
    for (let i = 0; i < orderedLinks.length; i++) {
        linkByteOffsets[i] = cursor;
        cursor += linkLengths[i];
    }

    const linksBlock = new Uint8Array(cursor);
    let pos = 0;
    for (const buf of linkBuffers) {
        linksBlock.set(buf, pos);
        pos += buf.length;
    }

    const adjacencyBlock = writeAdj
        ? buildLinkAdjacencyBlock(orderedLinks, linkLengths, featureCount)
        : null;
    // A link spatial index needs bbox info per link. We can compute it
    // from feature endpoints (when features have geometry) or from a
    // link's own LineString. If neither is available — pure graph
    // mode without geometric links — we silently skip the index rather
    // than throw, matching the user expectation that "every default
    // index is enabled if it's meaningful".
    const canBuildLinkRTree =
        options.featureBboxes !== undefined || orderedLinks.some((l) => l.geometry);
    const spatialIndexBlock =
        writeRTree && orderedLinks.length > 0 && canBuildLinkRTree
            ? buildLinkSpatialIndexBlock(orderedLinks, linkByteOffsets, options.featureBboxes)
            : null;

    return { linksBlock, adjacencyBlock, spatialIndexBlock, linkColumns, orderedLinks, linkSizes: linkLengths };
}

function parseLinkProperties(bytes: Uint8Array, columns: ColumnMeta[] | null): LinkProperties {
    const properties: LinkProperties = {};
    if (!columns || columns.length === 0 || bytes.length === 0) return properties;

    const view = new DataView(bytes.buffer, bytes.byteOffset);
    let offset = 0;

    while (offset < bytes.length) {
        const colIndex = view.getUint16(offset, true);
        offset += 2;

        if (colIndex >= columns.length) break;
        const column = columns[colIndex];

        switch (column.type) {
            case ColumnType.Bool:
                properties[column.name] = view.getUint8(offset) !== 0;
                offset += 1;
                break;
            case ColumnType.Byte:
                properties[column.name] = view.getInt8(offset);
                offset += 1;
                break;
            case ColumnType.UByte:
                properties[column.name] = view.getUint8(offset);
                offset += 1;
                break;
            case ColumnType.Short:
                properties[column.name] = view.getInt16(offset, true);
                offset += 2;
                break;
            case ColumnType.UShort:
                properties[column.name] = view.getUint16(offset, true);
                offset += 2;
                break;
            case ColumnType.Int:
                properties[column.name] = view.getInt32(offset, true);
                offset += 4;
                break;
            case ColumnType.UInt:
                properties[column.name] = view.getUint32(offset, true);
                offset += 4;
                break;
            case ColumnType.Long:
                properties[column.name] = Number(view.getBigInt64(offset, true));
                offset += 8;
                break;
            case ColumnType.ULong:
                properties[column.name] = Number(view.getBigUint64(offset, true));
                offset += 8;
                break;
            case ColumnType.Float:
                properties[column.name] = view.getFloat32(offset, true);
                offset += 4;
                break;
            case ColumnType.Double:
                properties[column.name] = view.getFloat64(offset, true);
                offset += 8;
                break;
            case ColumnType.DateTime:
            case ColumnType.String: {
                const len = view.getUint32(offset, true);
                offset += 4;
                properties[column.name] = textDecoder.decode(bytes.subarray(offset, offset + len));
                offset += len;
                break;
            }
            case ColumnType.Json: {
                const len = view.getUint32(offset, true);
                offset += 4;
                const str = textDecoder.decode(bytes.subarray(offset, offset + len));
                properties[column.name] = JSON.parse(str);
                offset += len;
                break;
            }
            case ColumnType.Binary: {
                const len = view.getUint32(offset, true);
                offset += 4;
                properties[column.name] = bytes.slice(offset, offset + len);
                offset += len;
                break;
            }
            default:
                throw new Error(`Unknown column type: ${column.type}`);
        }
    }

    return properties;
}

function parseLinkGeometry(bytes: Uint8Array, offset: number): { geometry: LineString | null; consumed: number } {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const pointCount = view.getUint32(0, true);
    if (pointCount === 0) {
        return { geometry: null, consumed: 4 };
    }
    const coordinates: number[][] = new Array(pointCount);
    let pos = 4;
    for (let i = 0; i < pointCount; i++) {
        const x = view.getFloat64(pos, true);
        pos += 8;
        const y = view.getFloat64(pos, true);
        pos += 8;
        coordinates[i] = [x, y];
    }
    return {
        geometry: { type: 'LineString', coordinates },
        consumed: pos,
    };
}

export function parseLink(bytes: Uint8Array, offset: number, size: number, columns: ColumnMeta[] | null): Link {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);

    const from = view.getUint32(0, true);
    const to = view.getUint32(4, true);

    const { geometry, consumed } = parseLinkGeometry(bytes, offset + 8);
    const propsStart = 8 + consumed;

    let properties: LinkProperties = {};
    if (columns && columns.length > 0 && size > propsStart) {
        const propsBytes = bytes.subarray(offset + propsStart, offset + size);
        properties = parseLinkProperties(propsBytes, columns);
    }

    return { from, to, geometry, properties };
}

/** Parse every link in `bytes` (positioned at the start of the links
 *  payload, with `length` covering the whole block) into an array. */
export function parseLinksBlock(bytes: Uint8Array, length: number, columns: ColumnMeta[] | null): Link[] {
    const links: Link[] = [];
    let cursor = 0;
    while (cursor < length) {
        const size = new DataView(bytes.buffer, bytes.byteOffset + cursor).getUint32(0, true);
        links.push(parseLink(bytes, cursor + SIZE_PREFIX_LEN, size, columns));
        cursor += SIZE_PREFIX_LEN + size;
    }
    return links;
}
