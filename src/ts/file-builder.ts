import * as flatbuffers from 'flatbuffers';
import type { ColumnMeta } from './column-meta.js';
import { magicbytes } from './constants.js';
import { crc32 } from './crc32.js';
import { Column } from './fbs/column.js';
import { ColumnIndexEntry } from './fbs/column-index-entry.js';
import { Crs } from './fbs/crs.js';
import type { GeometryType } from './fbs/geometry-type.js';
import { Header } from './fbs/header.js';

export interface ColumnIndexBlock {
    column: string;
    bytes: Uint8Array;
}

/**
 * Description of every payload block plus the schema/metadata
 * needed to write the FlatRecord header. Each block field is
 * `null` when the block is absent from the file.
 *
 * The builder takes care of computing absolute offsets (in the
 * resulting file) and populating the header's directory.
 */
export interface FileBuildSpec {
    // Header metadata
    geometryType: GeometryType;
    /** `true` when at least one feature carries geometry. */
    hasFeatureGeometry: boolean;
    columns: ColumnMeta[] | null;
    envelope: Float64Array | null;
    featuresCount: number;
    indexNodeSize: number;
    crsCode: number;
    title?: string | null;
    description?: string | null;
    metadata?: string | null;
    /** Unix time in milliseconds. `0` / `undefined` = not set. */
    timestamp?: number;
    /** When `true`, computes a CRC32 over the header bytes and stores
     *  it in `header_crc32`. Adds one extra pass + a buffer scan. */
    writeHeaderCrc?: boolean;

    // Feature blocks
    featureSpatialIndex: Uint8Array | null;
    featureColumnIndices: ColumnIndexBlock[];
    featuresBlock: Uint8Array | null;

    // Link blocks
    linksCount: number;
    linkColumns: ColumnMeta[] | null;
    linkSpatialIndex: Uint8Array | null;
    linkColumnIndices: ColumnIndexBlock[];
    linkAdjacencyIndex: Uint8Array | null;
    /** Reverse adjacency CSR (incomingLinksOf). Optional. */
    linkReverseAdjacencyIndex: Uint8Array | null;
    linksBlock: Uint8Array | null;
}

interface OffsetMap {
    featureSpatialIndex: number;
    featureColumnIndices: number[];
    featuresBlock: number;
    linkSpatialIndex: number;
    linkColumnIndices: number[];
    linkAdjacencyIndex: number;
    linkReverseAdjacencyIndex: number;
    linksBlock: number;
}

function buildColumn(builder: flatbuffers.Builder, column: ColumnMeta): number {
    const nameOffset = builder.createString(column.name);
    Column.startColumn(builder);
    Column.addName(builder, nameOffset);
    Column.addType(builder, column.type);
    return Column.endColumn(builder);
}

function buildColumnIndexEntries(
    builder: flatbuffers.Builder,
    blocks: ColumnIndexBlock[],
    offsets: number[],
): number[] {
    return blocks.map((b, i) => {
        const nameOff = builder.createString(b.column);
        return ColumnIndexEntry.createColumnIndexEntry(
            builder,
            nameOff,
            BigInt(offsets[i]),
            BigInt(b.bytes.byteLength),
        );
    });
}

function buildHeader(spec: FileBuildSpec, offsets: OffsetMap): Uint8Array {
    const builder = new flatbuffers.Builder();

    const nameOffset = builder.createString('L1');

    let columnOffsets: number | undefined;
    if (spec.columns && spec.columns.length > 0) {
        columnOffsets = Header.createColumnsVector(
            builder,
            spec.columns.map((c) => buildColumn(builder, c)),
        );
    }

    let linkColumnOffsets: number | undefined;
    if (spec.linkColumns && spec.linkColumns.length > 0) {
        linkColumnOffsets = Header.createLinkColumnsVector(
            builder,
            spec.linkColumns.map((c) => buildColumn(builder, c)),
        );
    }

    let envelopeOffset: number | undefined;
    if (spec.envelope && spec.envelope.length === 4) {
        envelopeOffset = Header.createEnvelopeVector(builder, spec.envelope);
    }

    let crsOffset: number | undefined;
    if (spec.crsCode) {
        Crs.startCrs(builder);
        Crs.addCode(builder, spec.crsCode);
        crsOffset = Crs.endCrs(builder);
    }

    let featureColumnIndicesVec: number | undefined;
    if (spec.featureColumnIndices.length > 0) {
        const entries = buildColumnIndexEntries(builder, spec.featureColumnIndices, offsets.featureColumnIndices);
        featureColumnIndicesVec = Header.createFeatureColumnIndicesVector(builder, entries);
    }
    let linkColumnIndicesVec: number | undefined;
    if (spec.linkColumnIndices.length > 0) {
        const entries = buildColumnIndexEntries(builder, spec.linkColumnIndices, offsets.linkColumnIndices);
        linkColumnIndicesVec = Header.createLinkColumnIndicesVector(builder, entries);
    }

    Header.startHeader(builder);
    if (crsOffset !== undefined) Header.addCrs(builder, crsOffset);
    Header.addFeaturesCount(builder, BigInt(spec.featuresCount));
    Header.addGeometryType(builder, spec.geometryType);
    Header.addIndexNodeSize(builder, spec.indexNodeSize);
    if (envelopeOffset !== undefined) Header.addEnvelope(builder, envelopeOffset);
    if (columnOffsets !== undefined) Header.addColumns(builder, columnOffsets);
    Header.addName(builder, nameOffset);
    // Unix-time-in-ms timestamp (optional). 0 = "not set" / elided.
    if (spec.timestamp !== undefined && spec.timestamp !== 0) {
        Header.addTimestamp(builder, BigInt(Math.trunc(spec.timestamp)));
    }

    if (spec.featureSpatialIndex) {
        Header.addFeatureSpatialIndexOffset(builder, BigInt(offsets.featureSpatialIndex));
        Header.addFeatureSpatialIndexLength(builder, BigInt(spec.featureSpatialIndex.byteLength));
    }
    if (featureColumnIndicesVec !== undefined) {
        Header.addFeatureColumnIndices(builder, featureColumnIndicesVec);
    }
    if (spec.featuresBlock) {
        Header.addFeaturesOffset(builder, BigInt(offsets.featuresBlock));
        Header.addFeaturesLength(builder, BigInt(spec.featuresBlock.byteLength));
    }

    if (spec.linksCount > 0) Header.addLinksCount(builder, BigInt(spec.linksCount));
    if (linkColumnOffsets !== undefined) Header.addLinkColumns(builder, linkColumnOffsets);

    if (spec.linkSpatialIndex) {
        Header.addLinkSpatialIndexOffset(builder, BigInt(offsets.linkSpatialIndex));
        Header.addLinkSpatialIndexLength(builder, BigInt(spec.linkSpatialIndex.byteLength));
    }
    if (linkColumnIndicesVec !== undefined) {
        Header.addLinkColumnIndices(builder, linkColumnIndicesVec);
    }
    if (spec.linkAdjacencyIndex) {
        Header.addLinkAdjacencyIndexOffset(builder, BigInt(offsets.linkAdjacencyIndex));
        Header.addLinkAdjacencyIndexLength(builder, BigInt(spec.linkAdjacencyIndex.byteLength));
    }
    if (spec.linksBlock) {
        Header.addLinksOffset(builder, BigInt(offsets.linksBlock));
        Header.addLinksLength(builder, BigInt(spec.linksBlock.byteLength));
    }

    // The default is `true` (FlatGeobuf-style: features always have
    // geometry); we only write the field when it diverges to keep the
    // header compact on geo / geograph files.
    if (!spec.hasFeatureGeometry) {
        Header.addHasFeatureGeometry(builder, false);
    }

    if (spec.linkReverseAdjacencyIndex) {
        Header.addLinkReverseAdjacencyIndexOffset(builder, BigInt(offsets.linkReverseAdjacencyIndex));
        Header.addLinkReverseAdjacencyIndexLength(builder, BigInt(spec.linkReverseAdjacencyIndex.byteLength));
    }

    const off = Header.endHeader(builder);
    builder.finishSizePrefixed(off);
    return builder.asUint8Array() as Uint8Array;
}

/** Size of the CRC32 slot that sits immediately after the header
 *  bytes — present unconditionally so absolute payload offsets are
 *  stable regardless of whether the writer computes a CRC. */
const HEADER_CRC_LEN = 4;

/**
 * Assemble a complete FlatRecord file from header metadata + payload blocks.
 *
 * File layout:
 *
 *   [Magic 8B][HeaderSize 4B][Header bytes][CRC32 4B][Payload blocks]
 *
 * The flatbuffer header carries a directory of absolute offsets into
 * every present block. The builder does two passes:
 *
 *   1. **Probe pass** — build the header with every present block's
 *      offset set to a non-zero sentinel (`1`). Flatbuffer scalar
 *      fields take fixed bytes when the value differs from the field's
 *      default (`0` here), so the only thing controlling the header's
 *      serialized size is *which* fields are written, not their values.
 *      We can therefore read the header's final size from the probe
 *      without yet knowing where blocks will land in the file.
 *   2. **Real pass** — knowing the header size, compute each block's
 *      real absolute offset, then rebuild the header with those
 *      offsets. Same set of present fields → same serialized size as
 *      the probe.
 *
 * The 4-byte CRC slot lives OUTSIDE the flatbuffer (writing it inside
 * would break the stable-header-size invariant because non-default
 * values would un-elide the field). Value `0` means the writer did
 * not compute a CRC; readers skip verification.
 *
 * A real block offset of `0` would not roundtrip (flatbuffer would
 * elide it as default), but no block can ever sit at file offset 0:
 * the first 8 bytes are always the magic prefix.
 */
export function buildFile(spec: FileBuildSpec): Uint8Array {
    const sentinelOffsets: OffsetMap = {
        featureSpatialIndex: 1,
        featureColumnIndices: spec.featureColumnIndices.map(() => 1),
        featuresBlock: 1,
        linkSpatialIndex: 1,
        linkColumnIndices: spec.linkColumnIndices.map(() => 1),
        linkAdjacencyIndex: 1,
        linkReverseAdjacencyIndex: 1,
        linksBlock: 1,
    };
    const probeHeader = buildHeader(spec, sentinelOffsets);
    const headerLen = probeHeader.byteLength;

    // Compute real offsets. Order inside the payload region:
    //   feature col indices … → feature spatial index → features block
    //   → link col indices … → link spatial index → link adjacency
    //   → link reverse adjacency → links block
    //
    // The CRC slot (4B) sits between the header and the first payload
    // block, so payload offsets start at magic + header + 4.
    let cursor = magicbytes.length + headerLen + HEADER_CRC_LEN;
    const real: OffsetMap = {
        featureSpatialIndex: 0,
        featureColumnIndices: [],
        featuresBlock: 0,
        linkSpatialIndex: 0,
        linkColumnIndices: [],
        linkAdjacencyIndex: 0,
        linkReverseAdjacencyIndex: 0,
        linksBlock: 0,
    };

    for (const b of spec.featureColumnIndices) {
        real.featureColumnIndices.push(cursor);
        cursor += b.bytes.byteLength;
    }
    if (spec.featureSpatialIndex) {
        real.featureSpatialIndex = cursor;
        cursor += spec.featureSpatialIndex.byteLength;
    }
    if (spec.featuresBlock) {
        real.featuresBlock = cursor;
        cursor += spec.featuresBlock.byteLength;
    }
    for (const b of spec.linkColumnIndices) {
        real.linkColumnIndices.push(cursor);
        cursor += b.bytes.byteLength;
    }
    if (spec.linkSpatialIndex) {
        real.linkSpatialIndex = cursor;
        cursor += spec.linkSpatialIndex.byteLength;
    }
    if (spec.linkAdjacencyIndex) {
        real.linkAdjacencyIndex = cursor;
        cursor += spec.linkAdjacencyIndex.byteLength;
    }
    if (spec.linkReverseAdjacencyIndex) {
        real.linkReverseAdjacencyIndex = cursor;
        cursor += spec.linkReverseAdjacencyIndex.byteLength;
    }
    if (spec.linksBlock) {
        real.linksBlock = cursor;
        cursor += spec.linksBlock.byteLength;
    }

    const header = buildHeader(spec, real);
    if (header.byteLength !== headerLen) {
        throw new Error(
            `Internal: header size changed between probe (${headerLen}) and final (${header.byteLength}) passes`,
        );
    }

    const total = cursor;
    const out = new Uint8Array(total);
    out.set(magicbytes, 0);
    out.set(header, magicbytes.length);

    // CRC slot — computed over the header bytes, then written into the
    // 4 bytes immediately after the header. `0` means the writer did
    // not compute one; readers skip verification.
    const crcPos = magicbytes.length + header.byteLength;
    if (spec.writeHeaderCrc) {
        const crcValue = crc32(header);
        new DataView(out.buffer).setUint32(crcPos, crcValue, true);
    }

    let pos = crcPos + HEADER_CRC_LEN;
    for (const b of spec.featureColumnIndices) {
        out.set(b.bytes, pos);
        pos += b.bytes.byteLength;
    }
    if (spec.featureSpatialIndex) {
        out.set(spec.featureSpatialIndex, pos);
        pos += spec.featureSpatialIndex.byteLength;
    }
    if (spec.featuresBlock) {
        out.set(spec.featuresBlock, pos);
        pos += spec.featuresBlock.byteLength;
    }
    for (const b of spec.linkColumnIndices) {
        out.set(b.bytes, pos);
        pos += b.bytes.byteLength;
    }
    if (spec.linkSpatialIndex) {
        out.set(spec.linkSpatialIndex, pos);
        pos += spec.linkSpatialIndex.byteLength;
    }
    if (spec.linkAdjacencyIndex) {
        out.set(spec.linkAdjacencyIndex, pos);
        pos += spec.linkAdjacencyIndex.byteLength;
    }
    if (spec.linkReverseAdjacencyIndex) {
        out.set(spec.linkReverseAdjacencyIndex, pos);
        pos += spec.linkReverseAdjacencyIndex.byteLength;
    }
    if (spec.linksBlock) {
        out.set(spec.linksBlock, pos);
        pos += spec.linksBlock.byteLength;
    }

    if (pos !== out.byteLength) {
        throw new Error(`Internal: file builder ended at ${pos}, expected ${out.byteLength}`);
    }
    return out;
}
