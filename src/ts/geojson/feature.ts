import type { Feature as GeoJsonFeature } from 'geojson';
import type { Feature } from '../fbs/feature.js';
import type { Geometry } from '../fbs/geometry.js';
import { parseProperties } from '../codec/feature.js';
import type { HeaderMeta } from '../header-meta.js';
import { fromGeometry } from './geometry.js';

/** A FlatRecord feature decoded into a plain GeoJSON `Feature`.
 *  Currently an alias for the geojson package's `Feature` — readers
 *  return exactly what `JSON.parse` of an equivalent GeoJSON file
 *  would produce, so existing GeoJSON tooling drops in unchanged. */
export type IGeoJsonFeature = GeoJsonFeature;

export function fromFeature(id: number, feature: Feature, header: HeaderMeta): IGeoJsonFeature {
    const columns = header.columns;
    const rawGeometry = feature.geometry() as Geometry | null;
    const geometry = rawGeometry ? fromGeometry(rawGeometry, header.geometryType) : null;
    const geoJsonfeature: GeoJsonFeature = {
        type: 'Feature',
        id,
        geometry: geometry as GeoJsonFeature['geometry'],
        properties: parseProperties(feature, columns),
    };
    return geoJsonfeature;
}
