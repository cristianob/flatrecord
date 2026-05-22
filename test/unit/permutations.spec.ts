/**
 * Table-driven coverage of every meaningful permutation of FlatRecord index
 * flags. Each row enumerates the 5 boolean writer toggles times the
 * "has edges" data dimension, builds the corresponding fixture, and
 * verifies that:
 *
 *  - serialize() does not throw
 *  - FlatRecord.open() round-trips the metadata
 *  - deserialize() round-trips features and edges
 *  - each query method works iff its prerequisites are met, and throws
 *    a descriptive error otherwise
 *
 * The matrix is exhaustive: 2^6 = 64 permutations, ranging from the
 * empty file (no indices, no edges) to the fully-decorated graph (all
 * three structural indices + property indices on both sides).
 */

import type { FeatureCollection as GeoJsonFeatureCollection } from 'geojson';
import { beforeAll, describe, expect, it } from 'vitest';
import { deserialize, FlatRecord, serialize } from '../../src/ts/geojson.js';
import type { AdjacencyListInput } from '../../src/ts/link-types.js';

interface PermFlags {
    writeSpatialIndex: boolean;
    writeAdjacencyIndex: boolean;
    writeReverseAdjacencyIndex: boolean;
    writeLinkSpatialIndex: boolean;
    writeColumnIndexFeatures: boolean;
    writeColumnIndexLinks: boolean;
    hasEdges: boolean;
}

const FEATURES: GeoJsonFeatureCollection = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-46.63, -23.55] },
            properties: { name: 'São Paulo', icao: 'SBSP', elev_ft: 2461, intl: true },
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-43.17, -22.91] },
            properties: { name: 'Rio de Janeiro', icao: 'SBRJ', elev_ft: 11, intl: false },
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-47.93, -15.78] },
            properties: { name: 'Brasília', icao: 'SBBR', elev_ft: 3497, intl: true },
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-49.27, -16.68] },
            properties: { name: 'São José do Rio Preto', icao: 'SBSR', elev_ft: 1784, intl: false },
        },
        {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [-44.2, -22.3] },
            properties: { name: 'Rio Preto', icao: 'SDRP', elev_ft: 100, intl: false },
        },
    ],
};
const N_FEATURES = FEATURES.features.length;

const EDGES: AdjacencyListInput = {
    links: [
        { from: 0, to: 1, properties: { road: 'BR-116', km: 429, paved: true } },
        { from: 0, to: 2, properties: { road: 'BR-050', km: 1015, paved: true } },
        { from: 0, to: 3, properties: { road: 'BR-153', km: 442, paved: true } },
        { from: 3, to: 4, properties: { road: 'BR-101', km: 770, paved: false } },
    ],
};
const N_EDGES = EDGES.links.length;

function build(flags: PermFlags): Uint8Array {
    return serialize(FEATURES, flags.hasEdges ? EDGES : undefined, {
        writeSpatialIndex: flags.writeSpatialIndex,
        writeAdjacencyIndex: flags.writeAdjacencyIndex,
        writeReverseAdjacencyIndex: flags.writeReverseAdjacencyIndex,
        writeLinkSpatialIndex: flags.writeLinkSpatialIndex,
        writeColumnIndex: {
            features: flags.writeColumnIndexFeatures ? ['name', 'icao', 'elev_ft', 'intl'] : undefined,
            links: flags.writeColumnIndexLinks ? ['road', 'km', 'paved'] : undefined,
        },
    });
}

function effectivelyHasAdjacency(f: PermFlags): boolean {
    return f.writeAdjacencyIndex && f.hasEdges;
}
function effectivelyHasReverseAdjacency(f: PermFlags): boolean {
    return f.writeReverseAdjacencyIndex && f.hasEdges;
}
function effectivelyHasEdgeRTree(f: PermFlags): boolean {
    return f.writeLinkSpatialIndex && f.hasEdges;
}
function effectivelyHasEdgePropertyIndex(f: PermFlags): boolean {
    return f.writeColumnIndexLinks && f.hasEdges;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const v of iter) out.push(v);
    return out;
}

const BOOL = [false, true] as const;
const PERMUTATIONS: PermFlags[] = [];
for (const writeSpatialIndex of BOOL)
    for (const writeAdjacencyIndex of BOOL)
        for (const writeReverseAdjacencyIndex of BOOL)
            for (const writeLinkSpatialIndex of BOOL)
                for (const writeColumnIndexFeatures of BOOL)
                    for (const writeColumnIndexLinks of BOOL)
                        for (const hasEdges of BOOL)
                            PERMUTATIONS.push({
                                writeSpatialIndex,
                                writeAdjacencyIndex,
                                writeReverseAdjacencyIndex,
                                writeLinkSpatialIndex,
                                writeColumnIndexFeatures,
                                writeColumnIndexLinks,
                                hasEdges,
                            });

function label(f: PermFlags): string {
    const parts = [
        f.writeSpatialIndex ? 'F-RTree' : '·',
        f.writeAdjacencyIndex ? 'CSR' : '·',
        f.writeReverseAdjacencyIndex ? 'rCSR' : '·',
        f.writeLinkSpatialIndex ? 'L-RTree' : '·',
        f.writeColumnIndexFeatures ? 'F-Prop' : '·',
        f.writeColumnIndexLinks ? 'L-Prop' : '·',
        f.hasEdges ? 'links' : 'no-links',
    ];
    return parts.join('/');
}

describe('all index permutations (128 combinations)', () => {
    for (const flags of PERMUTATIONS) {
        describe(label(flags), () => {
            let bytes: Uint8Array;
            let fr: FlatRecord;

            beforeAll(async () => {
                bytes = build(flags);
                fr = await FlatRecord.open(bytes);
            });

            it('serializes and opens without error', () => {
                expect(fr.featuresCount).toBe(N_FEATURES);
                expect(fr.linksCount).toBe(flags.hasEdges ? N_EDGES : 0);
            });

            it('round-trips features and edges via deserialize', async () => {
                const { features, adjacencyList } = await deserialize(bytes);
                expect(features.length).toBe(N_FEATURES);
                expect(adjacencyList.links.length).toBe(flags.hasEdges ? N_EDGES : 0);
            });

            it('reports correct index flags via the metadata callback', async () => {
                let meta: import('../../src/ts/link-types.js').FlatRecordMeta | null = null;
                await deserialize(bytes, (m) => {
                    meta = m;
                });
                const m = meta as unknown as import('../../src/ts/link-types.js').FlatRecordMeta;
                expect(m.indexNodeSize > 0).toBe(flags.writeSpatialIndex);
                if (flags.hasEdges) {
                    expect((m.linkAdjacencyIndex.length > 0)).toBe(flags.writeAdjacencyIndex);
                    expect((m.linkSpatialIndex.length > 0)).toBe(flags.writeLinkSpatialIndex);
                    expect((m.linkColumnIndices.length > 0)).toBe(effectivelyHasEdgePropertyIndex(flags));
                }
            });

            it('featuresInBbox works iff vertex R-tree is present', async () => {
                const rect = { minX: -50, minY: -25, maxX: -40, maxY: -10 };
                if (flags.writeSpatialIndex) {
                    const hits = await collect(fr.featuresInBbox(rect));
                    expect(hits.length).toBeGreaterThan(0);
                } else {
                    await expect(collect(fr.featuresInBbox(rect))).rejects.toThrow(
                        /no geometry\.|writeSpatialIndex/i,
                    );
                }
            });

            it('outgoingLinksOf works iff adjacency CSR is present', async () => {
                if (effectivelyHasAdjacency(flags)) {
                    const out = await collect(fr.outgoingLinksOf(0));
                    expect(out.length).toBeGreaterThanOrEqual(0);
                } else {
                    await expect(collect(fr.outgoingLinksOf(0))).rejects.toThrow(
                        /adjacency|writeAdjacencyIndex/i,
                    );
                }
            });

            it('linksInBbox works iff edge R-tree is present', async () => {
                const rect = { minX: -50, minY: -25, maxX: -40, maxY: -10 };
                if (effectivelyHasEdgeRTree(flags)) {
                    const hits = await collect(fr.linksInBbox(rect));
                    expect(hits.length).toBeGreaterThanOrEqual(0);
                } else {
                    await expect(collect(fr.linksInBbox(rect))).rejects.toThrow(
                        /no links\.|writeLinkSpatialIndex/i,
                    );
                }
            });

            it('shortestPath works iff adjacency CSR is present', async () => {
                if (effectivelyHasAdjacency(flags)) {
                    const path = await fr.shortestPath(0, 1, { heuristic: null });
                    expect(path === null || path.links.length >= 0).toBe(true);
                } else {
                    await expect(fr.shortestPath(0, 1, { heuristic: null })).rejects.toThrow(
                        /adjacency|writeAdjacencyIndex/i,
                    );
                }
            });

            it('findFeaturesByText works iff vertex property index is present', async () => {
                if (flags.writeColumnIndexFeatures) {
                    const hits = await collect(fr.findFeaturesByText('name', 'brasilia'));
                    expect(hits.length).toBeGreaterThan(0);
                    expect(['A', 'B', 'C']).toContain(hits[0].tier);
                } else {
                    await expect(
                        collect(fr.findFeaturesByText('name', 'brasilia')),
                    ).rejects.toThrow(/feature column index|writeColumnIndex/i);
                }
            });

            it('findFeaturesByValue works iff vertex property index is present', async () => {
                if (flags.writeColumnIndexFeatures) {
                    const hits = await collect(fr.findFeaturesByValue('elev_ft', { gte: 1000 }));
                    expect(hits.length).toBeGreaterThan(0);
                } else {
                    await expect(
                        collect(fr.findFeaturesByValue('elev_ft', { gte: 1000 })),
                    ).rejects.toThrow(/feature column index|writeColumnIndex/i);
                }
            });

            it('findLinksByText works iff edge property index is present', async () => {
                if (effectivelyHasEdgePropertyIndex(flags)) {
                    const hits = await collect(fr.findLinksByText('road', 'br'));
                    expect(hits.length).toBeGreaterThan(0);
                    expect(['A', 'B', 'C']).toContain(hits[0].tier);
                } else {
                    await expect(collect(fr.findLinksByText('road', 'br'))).rejects.toThrow(
                        /link column index|writeColumnIndex/i,
                    );
                }
            });

            it('findLinksByValue works iff edge property index is present', async () => {
                if (effectivelyHasEdgePropertyIndex(flags)) {
                    const hits = await collect(fr.findLinksByValue('km', { gte: 500 }));
                    expect(hits.length).toBeGreaterThan(0);
                } else {
                    await expect(
                        collect(fr.findLinksByValue('km', { gte: 500 })),
                    ).rejects.toThrow(/link column index|writeColumnIndex/i);
                }
            });

            it('incomingLinksOf works iff reverse CSR is present', async () => {
                if (effectivelyHasReverseAdjacency(flags)) {
                    const incoming = await collect(fr.incomingLinksOf(1));
                    expect(incoming.length).toBeGreaterThanOrEqual(0);
                } else if (!flags.hasEdges) {
                    await expect(collect(fr.incomingLinksOf(1))).rejects.toThrow(
                        /no links/i,
                    );
                } else {
                    await expect(collect(fr.incomingLinksOf(1))).rejects.toThrow(
                        /reverse adjacency|writeReverseAdjacencyIndex/i,
                    );
                }
            });

            it('inDegreeOf works iff reverse CSR is present', async () => {
                if (effectivelyHasReverseAdjacency(flags)) {
                    const d = await fr.inDegreeOf(2);
                    expect(d).toBeGreaterThanOrEqual(0);
                } else if (!flags.hasEdges) {
                    // table-side links absent → in-degree of every feature is 0
                    expect(await fr.inDegreeOf(0)).toBe(0);
                } else {
                    await expect(fr.inDegreeOf(0)).rejects.toThrow(
                        /writeReverseAdjacencyIndex/i,
                    );
                }
            });

            it('outDegreeOf works iff forward CSR is present', async () => {
                if (effectivelyHasAdjacency(flags)) {
                    const d = await fr.outDegreeOf(0);
                    expect(d).toBeGreaterThanOrEqual(0);
                } else if (!flags.hasEdges) {
                    // No links anywhere — every out-degree is 0.
                    expect(await fr.outDegreeOf(0)).toBe(0);
                } else {
                    await expect(fr.outDegreeOf(0)).rejects.toThrow(
                        /writeAdjacencyIndex/i,
                    );
                }
            });

            it('linkIndexBetween works iff forward CSR is present', async () => {
                if (effectivelyHasAdjacency(flags)) {
                    // (0 → 1) is a real link in EDGES.
                    const l = await fr.linkIndexBetween(0, 1);
                    expect(l).not.toBeNull();
                    expect(l?.from).toBe(0);
                    expect(l?.to).toBe(1);
                } else if (!flags.hasEdges) {
                    expect(await fr.linkIndexBetween(0, 1)).toBeNull();
                } else {
                    await expect(fr.linkIndexBetween(0, 1)).rejects.toThrow(
                        /writeAdjacencyIndex/i,
                    );
                }
            });

            it('nearestFeatures works iff feature R-tree + geometry', async () => {
                if (flags.writeSpatialIndex) {
                    const out = await collect(
                        fr.nearestFeatures([-46.6, -23.5], { limit: 3 }),
                    );
                    expect(out.length).toBeGreaterThan(0);
                    expect(out.length).toBeLessThanOrEqual(3);
                    // Distances are non-decreasing.
                    for (let i = 1; i < out.length; i++) {
                        expect(out[i].distance).toBeGreaterThanOrEqual(out[i - 1].distance);
                    }
                } else {
                    await expect(
                        collect(fr.nearestFeatures([-46.6, -23.5], { limit: 3 })),
                    ).rejects.toThrow(/writeSpatialIndex|geometry/i);
                }
            });

            it('getLink works iff file has links', async () => {
                if (flags.hasEdges) {
                    const l = await fr.getLink(0);
                    expect(typeof l.from).toBe('number');
                    expect(typeof l.to).toBe('number');
                } else {
                    await expect(fr.getLink(0)).rejects.toThrow(/out of range/);
                }
            });

            it('getFeatures bulk returns features in input order', async () => {
                // Hilbert sort (writeSpatialIndex: true) reorders storage
                // indices, so we can't assume idx 0 == SBSP. Verify by
                // walking the file once and checking bulk matches that
                // canonical order.
                const all = await collect(fr.features());
                const out = await fr.getFeatures([2, 0, 4]);
                expect(out).toHaveLength(3);
                expect((out[0].properties as { icao: string }).icao).toBe(
                    (all[2].properties as { icao: string }).icao,
                );
                expect((out[1].properties as { icao: string }).icao).toBe(
                    (all[0].properties as { icao: string }).icao,
                );
                expect((out[2].properties as { icao: string }).icao).toBe(
                    (all[4].properties as { icao: string }).icao,
                );
            });

            it('getLinks bulk works iff file has links', async () => {
                if (flags.hasEdges) {
                    const out = await fr.getLinks([0, N_EDGES - 1]);
                    expect(out).toHaveLength(2);
                } else {
                    await expect(fr.getLinks([0])).rejects.toThrow(/no links/i);
                }
            });

            it('inspect() reflects writer flags', () => {
                const info = fr.inspect();
                expect(info.featuresCount).toBe(N_FEATURES);
                expect(info.linksCount).toBe(flags.hasEdges ? N_EDGES : 0);
                expect(info.indexes.featureSpatialIndex).toBe(flags.writeSpatialIndex);
                expect(info.indexes.adjacencyIndex).toBe(effectivelyHasAdjacency(flags));
                expect(info.indexes.reverseAdjacencyIndex).toBe(
                    effectivelyHasReverseAdjacency(flags),
                );
                expect(info.indexes.linkSpatialIndex).toBe(effectivelyHasEdgeRTree(flags));
                expect(info.indexes.featureColumnIndices.length > 0).toBe(
                    flags.writeColumnIndexFeatures,
                );
                expect(info.indexes.linkColumnIndices.length > 0).toBe(
                    effectivelyHasEdgePropertyIndex(flags),
                );
                expect(info.crc32.verified).toBe(true);
            });

            it('featureIndexBy works iff vertex property index is present', async () => {
                if (flags.writeColumnIndexFeatures) {
                    const idx = await fr.featureIndexBy({ column: 'icao', value: 'SBBR' });
                    expect(typeof idx).toBe('number');
                    expect(idx).toBeGreaterThanOrEqual(0);
                    expect(idx).toBeLessThan(N_FEATURES);
                } else {
                    await expect(
                        fr.featureIndexBy({ column: 'icao', value: 'SBBR' }),
                    ).rejects.toThrow(/feature column index|writeColumnIndex/i);
                }
            });
        });
    }
});
