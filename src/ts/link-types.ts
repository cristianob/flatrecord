import type { LineString } from 'geojson';
import type { HeaderMeta } from './header-meta.js';

export interface LinkProperties {
    [key: string]: boolean | number | string | Uint8Array | object | null | undefined;
}

export interface LinkInput {
    from: number;
    to: number;
    geometry?: LineString | null;
    properties?: LinkProperties;
}

export interface Link {
    from: number;
    to: number;
    geometry: LineString | null;
    properties: LinkProperties;
}

export interface AdjacencyListInput {
    links: LinkInput[];
}

export interface AdjacencyList {
    links: Link[];
}

/** Plain object record — a row in a tabular file. Each field maps onto
 *  the same column types as feature `properties`. */
export type Row = Record<string, unknown>;

/** The mode of a file, inferred from `geometryType` and presence of links.
 *  - `'table'` — features only, no geometry
 *  - `'geo'` — features with geometry
 *  - `'graph'` — features (no geometry) + links
 *  - `'geograph'` — features (with geometry) + links
 */
export type FlatRecordMode = 'table' | 'geo' | 'graph' | 'geograph';

/**
 * Structural snapshot of a file, surfaced by `deserialize()` via its
 * optional metadata callback. Composes `HeaderMeta` (every parsed
 * field of the binary header) with three convenience derivations
 * (`mode`, `hasGeometry`, `hasLinks`).
 */
export interface FlatRecordMeta extends HeaderMeta {
    mode: FlatRecordMode;
    hasGeometry: boolean;
    hasLinks: boolean;
}

/**
 * Result of `deserialize()`. Shape adapts to the file's mode:
 *
 *  - `geo` / `geograph` (file has feature geometry) — yields a
 *    `features: T[]` array. `T` is `IGeoJsonFeature` for the GeoJSON
 *    entry point.
 *  - `table` / `graph` (no feature geometry) — yields a `rows: Row[]`
 *    array, one plain object per feature, dropping the GeoJSON
 *    envelope that the caller never asked for.
 *
 * `adjacencyList` is present in every result; `links` is `[]` on
 * `table` / `geo` mode files.
 *
 * Discriminate on `result.mode` (or use `'rows' in result` / `'features' in result`).
 */
export type DeserializeResult<T> =
    | { mode: 'geo' | 'geograph'; features: T[]; adjacencyList: AdjacencyList }
    | { mode: 'table' | 'graph'; rows: Row[]; adjacencyList: AdjacencyList };

export type FlatRecordMetaFn = (meta: FlatRecordMeta) => void;

/** Derive `{ mode, hasGeometry, hasLinks }` from a parsed `HeaderMeta`.
 *  Single source of truth used by both `FlatRecord.meta()` and the
 *  metadata callback fired by `deserialize()`. */
export function flatRecordMetaOf(header: HeaderMeta): FlatRecordMeta {
    const hasGeometry = header.hasFeatureGeometry;
    const hasLinks = header.linksBlock.length > 0;
    const mode: FlatRecordMode =
        hasGeometry && hasLinks ? 'geograph' : hasGeometry ? 'geo' : hasLinks ? 'graph' : 'table';
    return { ...header, mode, hasGeometry, hasLinks };
}
