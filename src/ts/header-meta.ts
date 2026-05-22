import type * as flatbuffers from 'flatbuffers';

import type { ColumnMeta } from './column-meta.js';
import type { CrsMeta } from './crs-meta.js';
import type { GeometryType } from './fbs/geometry-type.js';
import { Header } from './fbs/header.js';

/** Location of a block (offset and length) in the file. `length === 0`
 *  means the block is absent. */
export interface BlockLocation {
    offset: number;
    length: number;
}

/** Per-column property index location in the file. */
export interface ColumnIndexLocation {
    column: string;
    offset: number;
    length: number;
}

/**
 * Full header metadata, including the directory that locates every
 * optional block within the file. All offsets are absolute (relative
 * to the start of the file).
 *
 * The presence of optional blocks is encoded purely via `length`:
 *  - `featureSpatialIndex.length === 0`  → no feature spatial index
 *  - `linkAdjacencyIndex.length === 0`   → no link adjacency CSR
 *  - `linksBlock.length === 0`           → no links (FlatTable / FlatGeo)
 *  - etc.
 *
 * The dataset's `mode` is inferred from `geometryType` and the
 * presence of links — see `FlatRecord.mode`.
 */
export interface HeaderMeta {
    /** Feature geometry type. `Unknown` means either heterogeneous
     *  (mixed per-feature geometry types — distinguish via
     *  `hasFeatureGeometry: true`) or no geometry at all
     *  (`hasFeatureGeometry: false`). */
    geometryType: GeometryType;
    /** `true` when at least one feature has geometry. `false` on
     *  purely tabular files (`table` / `graph` modes). */
    hasFeatureGeometry: boolean;
    /** Feature column schema. */
    columns: ColumnMeta[] | null;
    envelope: Float64Array | null;
    featuresCount: number;
    /** Node size used for both feature and link R-trees. */
    indexNodeSize: number;
    crs: CrsMeta | null;
    /** Dataset short identifier. `null` when the writer didn't set one. */
    name: string | null;
    title: string | null;
    description: string | null;
    metadata: string | null;
    /** Unix time in milliseconds (matches `Date.now()`). `null` when
     *  the writer didn't set one. */
    timestamp: number | null;

    // Feature directory.
    featureSpatialIndex: BlockLocation;
    featureColumnIndices: ColumnIndexLocation[];
    featuresBlock: BlockLocation;

    // Link directory + schema.
    linksCount: number;
    linkColumns: ColumnMeta[] | null;
    linkSpatialIndex: BlockLocation;
    linkColumnIndices: ColumnIndexLocation[];
    linkAdjacencyIndex: BlockLocation;
    /** Reverse adjacency CSR — `incomingLinksOf(v)` support. */
    linkReverseAdjacencyIndex: BlockLocation;
    linksBlock: BlockLocation;

    /** CRC32 of the header bytes with this field treated as 0 during
     *  computation. `0` means the writer didn't compute one. */
    headerCrc32: number;
}

function readColumns(header: Header, length: number, getter: 'columns' | 'linkColumns'): ColumnMeta[] | null {
    if (length === 0) return null;
    const out: ColumnMeta[] = [];
    for (let i = 0; i < length; i++) {
        const c = header[getter](i);
        if (!c) throw new Error('Column unexpectedly missing');
        if (!c.name()) throw new Error('Column name unexpectedly missing');
        out.push({
            name: c.name() as string,
            type: c.type(),
            title: c.title(),
            description: c.description(),
            width: c.width(),
            precision: c.precision(),
            scale: c.scale(),
            nullable: c.nullable(),
            unique: c.unique(),
            primary_key: c.primaryKey(),
        });
    }
    return out;
}

function readColumnIndexLocations(
    header: Header,
    length: number,
    getter: 'featureColumnIndices' | 'linkColumnIndices',
): ColumnIndexLocation[] {
    const out: ColumnIndexLocation[] = [];
    for (let i = 0; i < length; i++) {
        const e = header[getter](i);
        if (!e) throw new Error('ColumnIndexEntry unexpectedly missing');
        if (!e.name()) throw new Error('ColumnIndexEntry name unexpectedly missing');
        out.push({
            column: e.name() as string,
            offset: Number(e.offset()),
            length: Number(e.length()),
        });
    }
    return out;
}

export function fromByteBuffer(bb: flatbuffers.ByteBuffer): HeaderMeta {
    const header = Header.getSizePrefixedRootAsHeader(bb);

    const crs = header.crs();
    const crsMeta: CrsMeta | null = crs
        ? {
              org: crs.org(),
              code: crs.code(),
              name: crs.name(),
              description: crs.description(),
              wkt: crs.wkt(),
              code_string: crs.codeString(),
          }
        : null;

    return {
        geometryType: header.geometryType(),
        hasFeatureGeometry: header.hasFeatureGeometry(),
        columns: readColumns(header, header.columnsLength(), 'columns'),
        envelope: header.envelopeLength() > 0 ? header.envelopeArray() : null,
        featuresCount: Number(header.featuresCount()),
        indexNodeSize: header.indexNodeSize(),
        crs: crsMeta,
        name: header.name(),
        title: header.title(),
        description: header.description(),
        metadata: header.metadata(),
        timestamp: (() => {
            const t = header.timestamp();
            return t === BigInt(0) ? null : Number(t);
        })(),

        featureSpatialIndex: {
            offset: Number(header.featureSpatialIndexOffset()),
            length: Number(header.featureSpatialIndexLength()),
        },
        featureColumnIndices: readColumnIndexLocations(
            header,
            header.featureColumnIndicesLength(),
            'featureColumnIndices',
        ),
        featuresBlock: {
            offset: Number(header.featuresOffset()),
            length: Number(header.featuresLength()),
        },

        linksCount: Number(header.linksCount()),
        linkColumns: readColumns(header, header.linkColumnsLength(), 'linkColumns'),
        linkSpatialIndex: {
            offset: Number(header.linkSpatialIndexOffset()),
            length: Number(header.linkSpatialIndexLength()),
        },
        linkColumnIndices: readColumnIndexLocations(
            header,
            header.linkColumnIndicesLength(),
            'linkColumnIndices',
        ),
        linkAdjacencyIndex: {
            offset: Number(header.linkAdjacencyIndexOffset()),
            length: Number(header.linkAdjacencyIndexLength()),
        },
        linkReverseAdjacencyIndex: {
            offset: Number(header.linkReverseAdjacencyIndexOffset()),
            length: Number(header.linkReverseAdjacencyIndexLength()),
        },
        linksBlock: {
            offset: Number(header.linksOffset()),
            length: Number(header.linksLength()),
        },
        // Filled in by the file parser, not by the flatbuffer parser
        // (the slot lives outside the flatbuffer).
        headerCrc32: 0,
    };
}

