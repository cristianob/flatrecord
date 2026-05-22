import { GeometryType } from '../fbs/geometry-type.js';
import { toGeometryType } from './geometry.js';
import type { IGeoJsonFeature } from '../geojson/feature.js';

function featureGeomType(feature: IGeoJsonFeature): GeometryType {
    const g = feature.geometry;
    if (!g) return GeometryType.Unknown;
    return toGeometryType(g.type);
}

/**
 * Infer the dataset's geometry type from a GeoJSON FeatureCollection.
 * Returns `Unknown` when all features have null/missing geometry
 * (tabular mode) or when features have mixed geometry types.
 */
export function inferGeometryType(features: IGeoJsonFeature[]): GeometryType {
    let geometryType: GeometryType | undefined;
    let anyHasGeometry = false;

    for (const f of features) {
        const gtype = featureGeomType(f);
        if (gtype !== GeometryType.Unknown) anyHasGeometry = true;
        if (geometryType === undefined) {
            geometryType = gtype;
        } else if (geometryType !== gtype && gtype !== GeometryType.Unknown) {
            geometryType = GeometryType.Unknown;
            if (anyHasGeometry) break;
        }
    }
    if (geometryType === undefined) return GeometryType.Unknown;
    return geometryType;
}
