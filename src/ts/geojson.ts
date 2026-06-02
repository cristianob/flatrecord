import type { Feature as GeoJsonFeature, FeatureCollection as GeoJsonFeatureCollection } from 'geojson';
import type { IGeoJsonFeature } from './geojson/feature.js';
import {
    deserialize as fcDeserialize,
    serialize as fcSerialize,
    type SerializeOptions,
} from './geojson/featurecollection.js';
import type { AdjacencyListInput, DeserializeResult, FlatRecordMetaFn, Row } from './link-types.js';

export type { SerializeOptions, PropertyIndexSpec } from './geojson/featurecollection.js';
export type {
    MatchMode,
    TextQueryOptions,
    ValuePredicate,
    ValueQueryOptions,
    TextSearchHit,
} from './property-index.js';
export type {
    AdjacencyList,
    AdjacencyListInput,
    DeserializeResult,
    Link,
    LinkInput,
    LinkProperties,
    FlatRecordMeta,
    FlatRecordMetaFn,
    FlatRecordMode,
    Row,
} from './link-types.js';

// Random-access reader and byte-source abstraction
export {
    FlatRecord,
    type TextHit,
    type FeatureLookup,
    type DistanceUnit,
    type NearestFeaturesOptions,
    type PreloadOptions,
    type FlatRecordInspect,
    type FlatRecordBlockInfo,
} from './flat-record.js';
export type { SchemaSpec, ColumnSpec } from './geojson/featurecollection.js';
export { byteReaderFromUint8Array, byteReaderFromUrl, type ByteReader, type UrlReaderOptions } from './byte-reader.js';
export type { LinkWeightFn, HeuristicFn, ShortestPathOptions, ShortestPathResult } from './shortest-path.js';

/**
 * Encode a FlatRecord file.
 *
 * Two input shapes are accepted:
 *
 *  - A GeoJSON `FeatureCollection` — features may have geometry
 *    (`geo` / `geograph` mode) or `geometry: null` (`table` /
 *    `graph` mode). Supply `adjacency` to also write links.
 *
 *  - A plain array of objects — produces a `table` mode file with
 *    each object as one feature's properties. Use this when you
 *    don't have geometry and don't want the GeoJSON envelope.
 *    `adjacency` (when supplied) makes the file `graph` mode.
 *
 * Defaults: WGS84, every applicable index enabled.
 */
export function serialize(
    input: GeoJsonFeatureCollection,
    adjacencyList?: AdjacencyListInput,
    options?: SerializeOptions,
): Uint8Array;
export function serialize(
    rows: Row[],
    adjacencyList?: AdjacencyListInput,
    options?: SerializeOptions,
): Uint8Array;
export function serialize(
    input: GeoJsonFeatureCollection | Row[],
    adjacencyList?: AdjacencyListInput,
    options?: SerializeOptions,
): Uint8Array {
    const geojson = Array.isArray(input) ? rowsToFeatureCollection(input) : input;
    return fcSerialize(geojson, adjacencyList, options);
}

function rowsToFeatureCollection(rows: Row[]): GeoJsonFeatureCollection {
    return {
        type: 'FeatureCollection',
        features: rows.map(
            (row): GeoJsonFeature => ({
                type: 'Feature',
                geometry: null as unknown as GeoJsonFeature['geometry'],
                properties: row,
            }),
        ),
    };
}

export async function deserialize(
    bytes: Uint8Array,
    metaFn?: FlatRecordMetaFn,
): Promise<DeserializeResult<IGeoJsonFeature>> {
    return fcDeserialize(bytes, metaFn);
}
