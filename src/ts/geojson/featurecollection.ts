import * as flatbuffers from 'flatbuffers';
import type {
    FeatureCollection as GeoJsonFeatureCollection,
    Geometry as GeoJsonGeometry,
    GeometryCollection,
    LineString,
    MultiLineString,
    MultiPoint,
    MultiPolygon,
    Point,
    Polygon,
} from 'geojson';
import { columnMeta, inferColumnType, type ColumnMeta } from '../column-meta.js';
import { magicbytes, isValidMagicBytes, SIZE_PREFIX_LEN } from '../constants.js';
import { buildFeature, type IProperties } from '../codec/feature.js';
import { inferGeometryType } from '../codec/header.js';
import { GeometryType } from '../fbs/geometry-type.js';
import { Feature } from '../fbs/feature.js';
import { buildFile, type ColumnIndexBlock } from '../file-builder.js';
import { buildLinkBlocks, parseLink, parseLinksBlock } from '../link.js';
import {
    flatRecordMetaOf,
    type AdjacencyListInput,
    type DeserializeResult,
    type Link,
    type LinkInput,
    type FlatRecordMeta,
    type FlatRecordMetaFn,
    type Row,
} from '../link-types.js';
import { fromByteBuffer, type HeaderMeta } from '../header-meta.js';
import { DEFAULT_NODE_SIZE, type Rect } from '../packedrtree.js';
import { buildPackedRTree, envelopeOf, hilbertPermutation, type IndexItem } from '../packedrtree-writer.js';
import { fromFeature, type IGeoJsonFeature } from './feature.js';
import { parseGC, parseGeometry } from './geometry.js';
import { buildPropertyIndexBlock } from '../property-index.js';

export interface PropertyIndexSpec {
    /** Names of feature property fields to index. Type (text /
     *  number / boolean) is inferred from the first non-null value. */
    features?: string[];
    /** Names of link property fields to index. Same type-inference rule. */
    links?: string[];
}

/** Declarative schema for `serialize`'s `schema` option. Each entry
 *  maps a property name to its expected column type plus optional
 *  required / nullable flags. When supplied, the writer skips type
 *  inference and validates every record against the declared schema. */
export interface SchemaSpec {
    features?: Record<string, ColumnSpec>;
    links?: Record<string, ColumnSpec>;
}

export interface ColumnSpec {
    type:
        | 'Bool'
        | 'Byte'
        | 'UByte'
        | 'Short'
        | 'UShort'
        | 'Int'
        | 'UInt'
        | 'Long'
        | 'ULong'
        | 'Float'
        | 'Double'
        | 'String'
        | 'Json'
        | 'DateTime'
        | 'Binary';
    /** Throw at write time when this column is missing from a record. */
    required?: boolean;
    /** Allow `null` / `undefined` values (default: `true`). */
    nullable?: boolean;
}

export interface SerializeOptions {
    /** EPSG code for the dataset CRS (default: `4326`, WGS84). */
    crsCode?: number;
    /**
     * Write a packed Hilbert R-tree spatial index over features (default:
     * `true`). Reorders features along the Hilbert curve and remaps link
     * `from`/`to` accordingly. Ignored when the dataset has no geometry.
     */
    writeSpatialIndex?: boolean;
    /**
     * Write a CSR adjacency index in the file so neighbor lookup
     * (`outgoingLinksOf(v)`) is O(deg(v)). Required for `shortestPath`.
     * Causes links to be physically sorted by `from`. Default: `true`
     * (ignored when there is no adjacencyList).
     */
    writeAdjacencyIndex?: boolean;
    /**
     * Write a reverse adjacency CSR so `incomingLinksOf(v)` is O(deg).
     * Default: `true` (ignored when there is no adjacencyList).
     */
    writeReverseAdjacencyIndex?: boolean;
    /**
     * Write a packed Hilbert R-tree spatial index over links so
     * `linksInBbox(rect)` can locate intersecting links without
     * scanning the whole graph. Default: `true` (ignored when there is
     * no adjacencyList).
     */
    writeLinkSpatialIndex?: boolean;
    /**
     * Per-column property indices on features and/or links. Enables
     * `findFeaturesByText`, `findFeaturesByValue`, `findLinksByText`,
     * `findLinksByValue`. Default: no property indices.
     */
    writeColumnIndex?: PropertyIndexSpec;
    /**
     * Compute a CRC32 over the header bytes and store it in the
     * header's `header_crc32` field. Readers can verify the header is
     * intact before trusting the directory. Default: `true`.
     */
    writeHeaderCrc?: boolean;
    /**
     * Explicit column schema for features and/or links. When supplied,
     * skips type inference and validates every record against it:
     * unknown columns throw, type mismatches throw, missing required
     * columns throw. Default: schema is inferred from the first record.
     */
    schema?: SchemaSpec;
    /**
     * Unix timestamp in milliseconds (matches `Date.now()`) stored in
     * the header's `timestamp` field. Three shapes:
     *
     *  - `number`  → store this exact value
     *  - `'now'`   → store `Date.now()` at serialization time
     *  - omitted   → don't write a timestamp (reader sees `null`)
     */
    timestamp?: number | 'now';
    /**
     * Dataset identity strings stored in the header — all optional and
     * surfaced on the reader side via `fr.header.{name,title,description,metadata}`.
     * Each one defaults to `null` (i.e. unset) on the reader when the
     * writer didn't supply it.
     *
     *  - `name`        — short identifier
     *  - `title`       — free-form human-readable title
     *  - `description` — longer free-form text
     *  - `metadata`    — application-defined, conventionally a JSON string
     */
    name?: string;
    title?: string;
    description?: string;
    metadata?: string;
}

interface NormalizedOptions {
    crsCode: number;
    writeSpatialIndex: boolean;
    writeAdjacencyIndex: boolean;
    writeReverseAdjacencyIndex: boolean;
    writeLinkSpatialIndex: boolean;
    writeColumnIndex: PropertyIndexSpec;
    writeHeaderCrc: boolean;
    schema: SchemaSpec | undefined;
    timestamp: number | undefined;
    name: string | undefined;
    title: string | undefined;
    description: string | undefined;
    metadata: string | undefined;
}

function normalizeOptions(opts: SerializeOptions | undefined): NormalizedOptions {
    let timestamp: number | undefined;
    if (opts?.timestamp === 'now') timestamp = Date.now();
    else if (typeof opts?.timestamp === 'number') timestamp = opts.timestamp;
    return {
        crsCode: opts?.crsCode ?? 4326,
        writeSpatialIndex: opts?.writeSpatialIndex ?? true,
        writeAdjacencyIndex: opts?.writeAdjacencyIndex ?? true,
        writeReverseAdjacencyIndex: opts?.writeReverseAdjacencyIndex ?? true,
        writeLinkSpatialIndex: opts?.writeLinkSpatialIndex ?? true,
        writeColumnIndex: opts?.writeColumnIndex ?? {},
        writeHeaderCrc: opts?.writeHeaderCrc ?? true,
        schema: opts?.schema,
        timestamp,
        name: opts?.name,
        title: opts?.title,
        description: opts?.description,
        metadata: opts?.metadata,
    };
}

function bboxOf(geom: GeoJsonGeometry): Rect {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    const visit = (coords: unknown): void => {
        if (Array.isArray(coords)) {
            if (typeof coords[0] === 'number') {
                const x = coords[0] as number;
                const y = coords[1] as number;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            } else {
                for (const c of coords) visit(c);
            }
        }
    };

    if (geom.type === 'GeometryCollection') {
        for (const g of (geom as GeometryCollection).geometries) {
            const r = bboxOf(g);
            if (r.minX < minX) minX = r.minX;
            if (r.minY < minY) minY = r.minY;
            if (r.maxX > maxX) maxX = r.maxX;
            if (r.maxY > maxY) maxY = r.maxY;
        }
    } else {
        visit((geom as { coordinates: unknown }).coordinates);
    }

    return { minX, minY, maxX, maxY };
}

function remapLinks(adjacency: AdjacencyListInput, invPerm: number[]): AdjacencyListInput {
    const links: LinkInput[] = adjacency.links.map((l) => ({
        ...l,
        from: invPerm[l.from],
        to: invPerm[l.to],
    }));
    return { links };
}

/** Build the reverse adjacency CSR block:
 *    [csrOffsets: (N+1) × 4B uint32][linkByteOffsets: L × 4B uint32]
 *
 * `linkByteOffsets` is sorted by `link.to` ascending and gives the byte
 * offset (relative to the start of the links block) of each link.
 * `csrOffsets[v]` is the index into `linkByteOffsets` of the first
 * incoming link of feature `v`.
 *
 * Accepts `links` in `from`-sorted storage order (i.e. the writer's
 * canonical order when `writeAdjacencyIndex: true`); the function
 * derives per-link byte offsets by accumulating their sizes.
 */
function buildReverseAdjacencyBlock(
    links: LinkInput[],
    linkSizes: number[],
    featureCount: number,
): Uint8Array {
    const L = links.length;
    // Each link's byte offset in the links block (in `from`-sorted
    // storage order, as written).
    const linkByteOffsets = new Uint32Array(L);
    let pos = 0;
    for (let i = 0; i < L; i++) {
        linkByteOffsets[i] = pos;
        pos += linkSizes[i];
    }

    // Bucket-sort link storage indices by their `to` field.
    const counts = new Uint32Array(featureCount + 1);
    for (const l of links) counts[l.to + 1]++;
    for (let i = 1; i <= featureCount; i++) counts[i] += counts[i - 1];

    const sortedByteOffsets = new Uint32Array(L);
    const cursor = new Uint32Array(featureCount);
    for (let i = 0; i < L; i++) {
        const to = links[i].to;
        const slot = counts[to] + cursor[to]++;
        sortedByteOffsets[slot] = linkByteOffsets[i];
    }

    // Final block: CSR offsets (N+1 × 4B) || sorted byte offsets (L × 4B)
    const block = new Uint8Array((featureCount + 1) * 4 + L * 4);
    const view = new DataView(block.buffer);
    for (let v = 0; v <= featureCount; v++) {
        view.setUint32(v * 4, counts[v], true);
    }
    const offsetsBase = (featureCount + 1) * 4;
    for (let i = 0; i < L; i++) {
        view.setUint32(offsetsBase + i * 4, sortedByteOffsets[i], true);
    }
    return block;
}

const COLUMN_TYPE_NAMES: Record<string, number> = {
    Byte: 0,
    UByte: 1,
    Bool: 2,
    Short: 3,
    UShort: 4,
    Int: 5,
    UInt: 6,
    Long: 7,
    ULong: 8,
    Float: 9,
    Double: 10,
    String: 11,
    Json: 12,
    DateTime: 13,
    Binary: 14,
};

function specToColumnMeta(name: string, spec: ColumnSpec): ColumnMeta {
    const type = COLUMN_TYPE_NAMES[spec.type];
    if (type === undefined) throw new Error(`Unknown column type '${spec.type}' for '${name}'`);
    return columnMeta(name, type);
}

function expectedJsTypeFor(spec: ColumnSpec): 'boolean' | 'number' | 'string' | 'object' {
    switch (spec.type) {
        case 'Bool':
            return 'boolean';
        case 'Byte':
        case 'UByte':
        case 'Short':
        case 'UShort':
        case 'Int':
        case 'UInt':
        case 'Long':
        case 'ULong':
        case 'Float':
        case 'Double':
            return 'number';
        case 'String':
        case 'DateTime':
            return 'string';
        case 'Json':
            return 'object';
        case 'Binary':
            return 'object';
    }
}

/** Validate every record's properties against an explicit `SchemaSpec`.
 *  Throws on: unknown columns, type mismatches, missing required
 *  columns, null/undefined on non-nullable columns. */
function validateAgainstSchema(
    label: 'feature' | 'link',
    schema: Record<string, ColumnSpec>,
    records: ReadonlyArray<Record<string, unknown> | null | undefined>,
): void {
    const declared = new Set(Object.keys(schema));
    for (let i = 0; i < records.length; i++) {
        const props = records[i] ?? {};
        for (const [name, value] of Object.entries(props)) {
            if (!declared.has(name)) {
                throw new Error(`${label} ${i}: unknown column '${name}' (not in schema)`);
            }
        }
        for (const [name, spec] of Object.entries(schema)) {
            const v = (props as Record<string, unknown>)[name];
            if (v === null || v === undefined) {
                if (spec.required) {
                    throw new Error(`${label} ${i}: missing required column '${name}'`);
                }
                if (spec.nullable === false) {
                    throw new Error(`${label} ${i}: column '${name}' is not nullable`);
                }
                continue;
            }
            const expected = expectedJsTypeFor(spec);
            const actual = typeof v;
            if (expected === 'object') {
                if (spec.type === 'Binary' && !(v instanceof Uint8Array)) {
                    throw new Error(
                        `${label} ${i}: column '${name}' expected Uint8Array (Binary), got ${actual}`,
                    );
                }
                if (spec.type === 'Json' && (actual !== 'object' || v instanceof Uint8Array)) {
                    throw new Error(
                        `${label} ${i}: column '${name}' expected object (Json), got ${
                            v instanceof Uint8Array ? 'Uint8Array' : actual
                        }`,
                    );
                }
            } else if (actual !== expected) {
                throw new Error(
                    `${label} ${i}: column '${name}' expected ${expected} (${spec.type}), got ${actual}`,
                );
            }
        }
    }
}

/** Build one property-index block per requested column. Returns an
 *  empty array when no columns are requested or when there are no
 *  records to index. */
function buildColumnIndexBlocks(
    columns: string[] | undefined,
    count: number,
    propsAt: (i: number) => Record<string, unknown> | null | undefined,
): ColumnIndexBlock[] {
    if (!columns || columns.length === 0 || count === 0) return [];
    return columns.map((col) => ({
        column: col,
        bytes: buildPropertyIndexBlock({
            columns: [col],
            count,
            valueAt: (i, c) => propsAt(i)?.[c],
        }),
    }));
}

function parseFeatureGeometry(f: GeoJsonFeatureCollection['features'][number]) {
    if (!f.geometry) return null;
    if (f.geometry.type === 'GeometryCollection') {
        return parseGC(f.geometry as GeometryCollection);
    }
    return parseGeometry(
        f.geometry as Point | MultiPoint | LineString | MultiLineString | Polygon | MultiPolygon,
    );
}

export function serialize(
    featurecollection: GeoJsonFeatureCollection,
    adjacencyList?: AdjacencyListInput,
    options?: SerializeOptions,
): Uint8Array {
    const {
        crsCode,
        writeSpatialIndex,
        writeAdjacencyIndex,
        writeReverseAdjacencyIndex,
        writeLinkSpatialIndex,
        writeColumnIndex,
        writeHeaderCrc,
        schema,
        timestamp,
        name,
        title,
        description,
        metadata,
    } = normalizeOptions(options);
    const featureCount = featurecollection.features.length;
    const hasLinks = adjacencyList !== undefined && adjacencyList.links.length > 0;

    if (schema?.features) {
        validateAgainstSchema(
            'feature',
            schema.features,
            featurecollection.features.map((f) => f.properties as Record<string, unknown> | null),
        );
    }
    if (schema?.links && adjacencyList) {
        validateAgainstSchema(
            'link',
            schema.links,
            adjacencyList.links.map((l) => l.properties as Record<string, unknown> | null | undefined),
        );
    }

    // `inferGeometryType` returns `Unknown` either because no feature
    // has geometry (tabular mode) *or* because features have mixed
    // geometry types (still geo, just heterogeneous). Distinguish the
    // two by an actual presence check.
    const geometryType = inferGeometryType(featurecollection.features);
    const hasGeometry =
        geometryType !== GeometryType.Unknown ||
        featurecollection.features.some((f) => f.geometry !== null && f.geometry !== undefined);

    const wantsFeatureSpatialIndex = writeSpatialIndex && featureCount > 0 && hasGeometry;
    const indexNodeSize = wantsFeatureSpatialIndex ? DEFAULT_NODE_SIZE : 0;

    // Bboxes: only if we have geometry. Used both for the dataset envelope
    // and for Hilbert sort + R-tree.
    const bboxes: (Rect | null)[] = featurecollection.features.map((f) =>
        f.geometry ? bboxOf(f.geometry as GeoJsonGeometry) : null,
    );
    const validBboxes = bboxes.filter((b): b is Rect => b !== null);
    const envelope = validBboxes.length > 0 ? envelopeOf(validBboxes) : null;

    let orderedFeatures = featurecollection.features;
    let orderedBboxes: (Rect | null)[] = bboxes;
    let remappedAdjacency = adjacencyList;

    if (wantsFeatureSpatialIndex) {
        // Hilbert sort over features-with-geometry. The validBboxes parallel
        // bboxes; build a perm that places sorted features in front. We
        // assume hasGeometry implies every feature has a bbox (we don't
        // mix geo + non-geo features in the same file).
        if (validBboxes.length !== featureCount) {
            throw new Error(
                'Cannot write feature spatial index when only some features have geometry. ' +
                    'Either give every feature a geometry, or pass writeSpatialIndex: false.',
            );
        }
        const perm = hilbertPermutation(validBboxes, envelope as Rect);
        const isIdentity = perm.every((v, i) => v === i);
        if (!isIdentity) {
            orderedFeatures = perm.map((oldIdx) => featurecollection.features[oldIdx]);
            orderedBboxes = perm.map((oldIdx) => bboxes[oldIdx]);
            if (adjacencyList) {
                const invPerm = new Array<number>(perm.length);
                for (let i = 0; i < perm.length; i++) invPerm[perm[i]] = i;
                remappedAdjacency = remapLinks(adjacencyList, invPerm);
            }
        }
    }

    // Build feature schema columns. Explicit `schema.features` wins;
    // otherwise infer from the first feature with properties.
    let columns: ColumnMeta[] | null = null;
    if (schema?.features) {
        columns = Object.entries(schema.features).map(([k, v]) => specToColumnMeta(k, v));
    } else {
        const sampleProps = orderedFeatures.find((f) => f.properties)?.properties;
        if (sampleProps) {
            columns = Object.keys(sampleProps).map((k) =>
                columnMeta(k, inferColumnType((sampleProps as IProperties)[k])),
            );
        }
    }

    const headerMeta: HeaderMeta = {
        geometryType,
        hasFeatureGeometry: hasGeometry,
        columns,
        envelope: envelope
            ? new Float64Array([envelope.minX, envelope.minY, envelope.maxX, envelope.maxY])
            : null,
        featuresCount: featureCount,
        indexNodeSize,
        crs: null,
        name: null,
        title: null,
        description: null,
        metadata: null,
        timestamp: null,
        // Placeholders — buildFile fills these in.
        featureSpatialIndex: { offset: 0, length: 0 },
        featureColumnIndices: [],
        featuresBlock: { offset: 0, length: 0 },
        linksCount: 0,
        linkColumns: null,
        linkSpatialIndex: { offset: 0, length: 0 },
        linkColumnIndices: [],
        linkAdjacencyIndex: { offset: 0, length: 0 },
        linkReverseAdjacencyIndex: { offset: 0, length: 0 },
        linksBlock: { offset: 0, length: 0 },
        headerCrc32: 0,
    };

    // Features block
    const featureBuffers: Uint8Array[] = orderedFeatures.map((f) =>
        buildFeature(parseFeatureGeometry(f), f.properties as IProperties, headerMeta),
    );
    const featuresLength = featureBuffers.reduce((a, b) => a + b.length, 0);
    const featuresBlock = featuresLength > 0 ? new Uint8Array(featuresLength) : null;
    if (featuresBlock) {
        let pos = 0;
        for (const buf of featureBuffers) {
            featuresBlock.set(buf, pos);
            pos += buf.length;
        }
    }

    // Feature spatial index (R-tree over Hilbert-ordered features).
    let featureSpatialIndex: Uint8Array | null = null;
    if (wantsFeatureSpatialIndex && featureCount > 0) {
        const items: IndexItem[] = new Array(featureCount);
        let runningOffset = 0;
        for (let i = 0; i < featureCount; i++) {
            const r = orderedBboxes[i] as Rect;
            items[i] = {
                minX: r.minX,
                minY: r.minY,
                maxX: r.maxX,
                maxY: r.maxY,
                offset: runningOffset,
            };
            runningOffset += featureBuffers[i].length;
        }
        featureSpatialIndex = buildPackedRTree(items, DEFAULT_NODE_SIZE);
    }

    const featureColumnIndices = buildColumnIndexBlocks(
        writeColumnIndex.features,
        featureCount,
        (i) => orderedFeatures[i].properties as Record<string, unknown> | null | undefined,
    );

    // Link side
    let linksBlock: Uint8Array | null = null;
    let linkAdjacencyIndex: Uint8Array | null = null;
    let linkReverseAdjacencyIndex: Uint8Array | null = null;
    let linkSpatialIndex: Uint8Array | null = null;
    let linkColumns: ColumnMeta[] | null = null;
    let linksCount = 0;
    let orderedLinks: LinkInput[] = [];

    if (hasLinks && remappedAdjacency) {
        const onlyFeatureBboxes = orderedBboxes.every((b) => b !== null)
            ? (orderedBboxes as Rect[])
            : undefined;
        const declaredLinkColumns = schema?.links
            ? Object.entries(schema.links).map(([k, v]) => specToColumnMeta(k, v))
            : undefined;
        const result = buildLinkBlocks(remappedAdjacency, featureCount, {
            writeAdjacencyIndex,
            writeSpatialIndex: writeLinkSpatialIndex,
            featureBboxes: onlyFeatureBboxes,
            linkColumns: declaredLinkColumns,
        });
        linksBlock = result.linksBlock.byteLength > 0 ? result.linksBlock : null;
        linkAdjacencyIndex = result.adjacencyBlock;
        linkSpatialIndex = result.spatialIndexBlock;
        linkColumns = result.linkColumns;
        orderedLinks = result.orderedLinks;
        linksCount = orderedLinks.length;

        // Reverse adjacency CSR. Requires links to be in `from`-sorted
        // storage order — which is exactly what `writeAdjacencyIndex`
        // produces. Without forward CSR the storage order is the input
        // order, which is fine: the reverse CSR points at byte offsets,
        // not at semantic indices.
        if (writeReverseAdjacencyIndex && orderedLinks.length > 0) {
            linkReverseAdjacencyIndex = buildReverseAdjacencyBlock(
                orderedLinks,
                result.linkSizes,
                featureCount,
            );
        }
    }

    const linkColumnIndices = buildColumnIndexBlocks(
        writeColumnIndex.links,
        orderedLinks.length,
        (i) => orderedLinks[i].properties as Record<string, unknown> | null | undefined,
    );

    return buildFile({
        geometryType,
        hasFeatureGeometry: hasGeometry,
        columns,
        envelope: headerMeta.envelope,
        featuresCount: featureCount,
        indexNodeSize,
        crsCode,
        writeHeaderCrc,
        timestamp,
        name,
        title,
        description,
        metadata,
        featureSpatialIndex,
        featureColumnIndices,
        featuresBlock,
        linksCount,
        linkColumns,
        linkSpatialIndex,
        linkColumnIndices,
        linkAdjacencyIndex,
        linkReverseAdjacencyIndex,
        linksBlock,
    });
}

function parseFeatureBytes(bytes: Uint8Array, header: HeaderMeta, id: number): IGeoJsonFeature {
    const aligned = new Uint8Array(bytes.byteLength);
    aligned.set(bytes);
    const bb = new flatbuffers.ByteBuffer(aligned);
    const feature = Feature.getSizePrefixedRootAsFeature(bb);
    return fromFeature(id, feature, header) as IGeoJsonFeature;
}

function parseFeaturesBlock(bytes: Uint8Array, header: HeaderMeta): IGeoJsonFeature[] {
    const features: IGeoJsonFeature[] = new Array(header.featuresCount);
    let cursor = 0;
    for (let i = 0; i < header.featuresCount; i++) {
        const size = new DataView(bytes.buffer, bytes.byteOffset + cursor).getUint32(0, true);
        const featureBytes = bytes.subarray(cursor, cursor + SIZE_PREFIX_LEN + size);
        features[i] = parseFeatureBytes(featureBytes, header, i);
        cursor += SIZE_PREFIX_LEN + size;
    }
    return features;
}

function buildFlatRecordMeta(header: HeaderMeta): FlatRecordMeta {
    return flatRecordMetaOf(header);
}

function readHeader(bytes: Uint8Array): HeaderMeta {
    if (!isValidMagicBytes(bytes)) throw new Error('Not a FlatRecord file');
    const bb = new flatbuffers.ByteBuffer(bytes);
    bb.setPosition(magicbytes.length);
    const header = fromByteBuffer(bb);
    // Pull CRC from the 4-byte slot that sits immediately after the
    // flatbuffer header bytes. `0` means the writer didn't compute
    // one — readers should skip verification in that case.
    const headerSize = new DataView(bytes.buffer, bytes.byteOffset + magicbytes.length).getUint32(0, true);
    const crcOffset = magicbytes.length + SIZE_PREFIX_LEN + headerSize;
    if (bytes.byteLength >= crcOffset + 4) {
        header.headerCrc32 = new DataView(bytes.buffer, bytes.byteOffset + crcOffset).getUint32(0, true);
    }
    return header;
}

export async function deserialize(
    bytes: Uint8Array,
    metaFn?: FlatRecordMetaFn,
): Promise<DeserializeResult<IGeoJsonFeature>> {
    const header = readHeader(bytes);
    const meta = buildFlatRecordMeta(header);
    if (metaFn) metaFn(meta);

    let features: IGeoJsonFeature[] = [];
    if (header.featuresBlock.length > 0) {
        const block = bytes.subarray(
            header.featuresBlock.offset,
            header.featuresBlock.offset + header.featuresBlock.length,
        );
        features = parseFeaturesBlock(block, header);
    }

    let links: Link[] = [];
    if (header.linksBlock.length > 0) {
        const linksBytes = bytes.subarray(
            header.linksBlock.offset,
            header.linksBlock.offset + header.linksBlock.length,
        );
        links = parseLinksBlock(linksBytes, header.linksBlock.length, header.linkColumns);
    }

    const adjacencyList = { links };
    if (meta.hasGeometry) {
        return { mode: meta.mode as 'geo' | 'geograph', features, adjacencyList };
    }
    // Tabular / graph mode: drop the GeoJSON envelope and surface the
    // properties as plain row objects.
    const rows: Row[] = features.map((f) => (f.properties ?? {}) as Row);
    return { mode: meta.mode as 'table' | 'graph', rows, adjacencyList };
}

/**
 * Iterator-style decode. `input` may be a Uint8Array or a stream — a
 * stream is fully drained into memory before parsing because the
 * directory-based format requires the full header (and therefore the
 * block offsets) before any payload makes sense. For genuine streaming
 * over an HTTP source, use the `HttpReader` via `FlatRecord.open(url)`.
 *
 * `rect` filters via the feature spatial index when present; raw
 * bbox-on-parse fallback otherwise.
 */
export async function* deserializeStream(
    input: Uint8Array | ReadableStream,
    rect?: Rect,
    metaFn?: FlatRecordMetaFn,
): AsyncGenerator<IGeoJsonFeature> {
    const bytes = input instanceof Uint8Array ? input : await drainStream(input);
    const result = await deserialize(bytes, metaFn);
    // Streaming the GeoJSON view is only meaningful on `geo` / `geograph`
    // mode files. On `table` / `graph` mode files there are no geometries
    // to stream — callers should use `deserialize` directly to get rows.
    if (result.mode !== 'geo' && result.mode !== 'geograph') return;
    const features = result.features;
    if (!rect) {
        for (const f of features) yield f;
        return;
    }
    for (const f of features) {
        if (!f.geometry) continue;
        const b = bboxOf(f.geometry as GeoJsonGeometry);
        if (b.maxX < rect.minX || b.minX > rect.maxX) continue;
        if (b.maxY < rect.minY || b.minY > rect.maxY) continue;
        yield f;
    }
}

async function drainStream(stream: ReadableStream): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalLen = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array);
        totalLen += (value as Uint8Array).byteLength;
    }
    const buf = new Uint8Array(totalLen);
    let pos = 0;
    for (const c of chunks) {
        buf.set(c, pos);
        pos += c.byteLength;
    }
    return buf;
}

export async function* deserializeLinks(bytes: Uint8Array): AsyncGenerator<Link, void, unknown> {
    const header = readHeader(bytes);
    if (header.linksBlock.length === 0) return;
    const linksBytes = bytes.subarray(
        header.linksBlock.offset,
        header.linksBlock.offset + header.linksBlock.length,
    );
    let cursor = 0;
    const total = header.linksBlock.length;
    while (cursor < total) {
        const size = new DataView(linksBytes.buffer, linksBytes.byteOffset + cursor).getUint32(0, true);
        yield parseLink(linksBytes, cursor + SIZE_PREFIX_LEN, size, header.linkColumns);
        cursor += SIZE_PREFIX_LEN + size;
    }
}

