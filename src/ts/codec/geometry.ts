import type * as flatbuffers from 'flatbuffers';
import { Geometry } from '../fbs/geometry.js';
import { GeometryType } from '../fbs/geometry-type.js';

export interface IParsedGeometry {
    xy: number[];
    z?: number[];
    m?: number[];
    ends: number[];
    parts: IParsedGeometry[];
    type: GeometryType;
}

export function buildGeometry(builder: flatbuffers.Builder, parsedGeometry: IParsedGeometry) {
    const { xy, z, m, ends, parts, type } = parsedGeometry;

    if (parts) {
        const partOffsets = parts.map((part) => buildGeometry(builder, part));
        const partsOffset = Geometry.createPartsVector(builder, partOffsets);
        Geometry.startGeometry(builder);
        Geometry.addParts(builder, partsOffset);
        Geometry.addType(builder, type);
        return Geometry.endGeometry(builder);
    }

    const xyOffset = Geometry.createXyVector(builder, xy);
    let zOffset: number | undefined;
    if (z) zOffset = Geometry.createZVector(builder, z);

    let mOffset: number | undefined;
    if (m) mOffset = Geometry.createMVector(builder, m);

    let endsOffset: number | undefined;
    if (ends) endsOffset = Geometry.createEndsVector(builder, ends);

    Geometry.startGeometry(builder);
    if (endsOffset) Geometry.addEnds(builder, endsOffset);
    Geometry.addXy(builder, xyOffset);
    if (zOffset) Geometry.addZ(builder, zOffset);
    if (mOffset) Geometry.addM(builder, mOffset);
    Geometry.addType(builder, type);
    return Geometry.endGeometry(builder);
}

/** Flatten nested coordinate arrays into a single `xy` (and optional
 *  `z`) sequence. Used by the GeoJSON geometry parser. */
export function flat(a: number[] | number[][], xy: number[], z: number[]): number[] | undefined {
    if (a.length === 0) return;
    if (Array.isArray(a[0])) {
        for (const sa of a as number[][]) flat(sa, xy, z);
    } else {
        if (a.length === 2) xy.push(...(a as number[]));
        else {
            xy.push(a[0], (a as number[])[1]);
            z.push((a as number[])[2]);
        }
    }
}

/** Re-pair a flat `xy` (and optional `z`) array into the nested form
 *  GeoJSON expects. */
export function pairFlatCoordinates(xy: Float64Array, z?: Float64Array): number[][] {
    const newArray: number[][] = [];
    for (let i = 0; i < xy.length; i += 2) {
        const a = [xy[i], xy[i + 1]];
        if (z) a.push(z[i >> 1]);
        newArray.push(a);
    }
    return newArray;
}

export function toGeometryType(name?: string): GeometryType {
    if (!name) return GeometryType.Unknown;
    const type: GeometryType = (GeometryType as never)[name];
    return type;
}
