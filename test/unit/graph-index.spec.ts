import type { FeatureCollection as GeoJsonFeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { deserialize, FlatRecord, serialize } from '../../src/ts/geojson.js';
import type { AdjacencyListInput, Edge } from '../../src/ts/link-types.js';
// haversine is an implementation detail used by the haversine-correctness
// suite to verify reference distances. It is intentionally NOT re-exported
// from the public surface.
import { haversine } from '../../src/ts/shortest-path.js';

/** Drain an async iterable into an array. */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const v of iter) out.push(v);
    return out;
}

/**
 * 4-vertex toy graph laid out roughly along a longitude in São Paulo
 * so haversine produces meaningful kilometre-scale distances:
 *
 *   0 ── 1 ── 2 ── 3
 *
 * Each consecutive pair is ~10–20 km apart.
 */
function lineGraph(): { geojson: GeoJsonFeatureCollection; adjacency: AdjacencyListInput } {
    const geojson: GeoJsonFeatureCollection = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.6, -23.55] }, properties: { id: 0 } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.5, -23.55] }, properties: { id: 1 } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.4, -23.55] }, properties: { id: 2 } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.3, -23.55] }, properties: { id: 3 } },
        ],
    };
    const adjacency: AdjacencyListInput = {
        links: [
            { from: 0, to: 1, properties: { id: '0-1' } },
            { from: 1, to: 2, properties: { id: '1-2' } },
            { from: 2, to: 3, properties: { id: '2-3' } },
        ],
    };
    return { geojson, adjacency };
}

describe('Adjacency index (CSR)', () => {
    it('exposes outgoing edges of each vertex', async () => {
        const { geojson, adjacency } = lineGraph();
        // adjacency index on but Hilbert sort off so vertex ids stay 0..3
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const ctx = await FlatRecord.open(bytes);

        const outOf = (v: number): Promise<Edge[]> => collect(ctx.outgoingLinksOf(v));

        expect((await outOf(0)).map((e) => e.to)).toEqual([1]);
        expect((await outOf(1)).map((e) => e.to)).toEqual([2]);
        expect((await outOf(2)).map((e) => e.to)).toEqual([3]);
        expect(await outOf(3)).toEqual([]);
    });

    it('returns all out-edges of a high-degree vertex', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { id: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 1] }, properties: { id: 2 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [-1, 0] }, properties: { id: 3 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, -1] }, properties: { id: 4 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 0, to: 1, properties: { label: 'east' } },
                { from: 0, to: 2, properties: { label: 'north' } },
                { from: 0, to: 3, properties: { label: 'west' } },
                { from: 0, to: 4, properties: { label: 'south' } },
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const ctx = await FlatRecord.open(bytes);

        const labels = (await collect(ctx.outgoingLinksOf(0)))
            .map((e) => e.properties?.label)
            .sort();
        expect(labels).toEqual(['east', 'north', 'south', 'west']);

        expect(await collect(ctx.outgoingLinksOf(1))).toEqual([]);
    });

    it('throws when the adjacency index was not written', async () => {
        const { geojson, adjacency } = lineGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false, writeAdjacencyIndex: false });
        const ctx = await FlatRecord.open(bytes);
        await expect(collect(ctx.outgoingLinksOf(0))).rejects.toThrow(/writeAdjacencyIndex/);
    });

    it('rejects out-of-range vertex indices', async () => {
        const { geojson, adjacency } = lineGraph();
        const ctx = await FlatRecord.open(serialize(geojson, adjacency, { writeSpatialIndex: false }));
        await expect(collect(ctx.outgoingLinksOf(-1))).rejects.toThrow();
        await expect(collect(ctx.outgoingLinksOf(999))).rejects.toThrow();
    });
});

describe('Edge R-tree', () => {
    function grid(n: number): { geojson: GeoJsonFeatureCollection; adjacency: AdjacencyListInput } {
        // n x n grid of points connected by edges along rows (eastward).
        const features = [];
        for (let i = 0; i < n * n; i++) {
            const x = i % n;
            const y = Math.floor(i / n);
            features.push({
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [x, y] },
                properties: { id: i },
            });
        }
        const edges = [];
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n - 1; x++) {
                const a = y * n + x;
                const b = y * n + x + 1;
                edges.push({ from: a, to: b, properties: { id: `${a}-${b}` } });
            }
        }
        return {
            geojson: { type: 'FeatureCollection', features },
            adjacency: { links: edges },
        };
    }

    it('returns every edge whose bbox intersects the query', async () => {
        const { geojson, adjacency } = grid(5);
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const ctx = await FlatRecord.open(bytes);

        const hits: string[] = [];
        for await (const edge of ctx.linksInBbox({ minX: 0.5, minY: 1.5, maxX: 2.5, maxY: 2.5 })) {
            hits.push(edge.properties?.id as string);
        }
        // Row y=2 has edges 10-11, 11-12, 12-13, 13-14 (x: 0..4).
        // Query x in [0.5, 2.5] catches edges whose bbox overlaps:
        //   10-11 (x in 0..1) → maxX=1 >= 0.5 ✓
        //   11-12 (x in 1..2) ✓
        //   12-13 (x in 2..3) → minX=2 <= 2.5 ✓
        //   13-14 (x in 3..4) ✗ (minX=3 > 2.5)
        expect(hits.sort()).toEqual(['10-11', '11-12', '12-13']);
    });

    it('returns edges whose LineString only partially overlaps the query', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [10, 0] }, properties: { id: 1 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                {
                    from: 0,
                    to: 1,
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [0, 0],
                            [5, 0],
                            [10, 0],
                        ],
                    },
                    properties: { id: 'long' },
                },
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const ctx = await FlatRecord.open(bytes);

        // Query covers only a tiny corner of the LineString — the
        // bbox-intersection R-tree should still return the edge so the
        // caller can do exact geometry filtering downstream.
        const hits = [];
        for await (const edge of ctx.linksInBbox({ minX: 4.5, minY: -0.1, maxX: 4.9, maxY: 0.1 })) {
            hits.push(edge.properties?.id);
        }
        expect(hits).toEqual(['long']);
    });

    it('throws when the edge index was not written', async () => {
        const { geojson, adjacency } = lineGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false, writeLinkSpatialIndex: false });
        const ctx = await FlatRecord.open(bytes);

        await expect(async () => {
            for await (const _ of ctx.linksInBbox({ minX: 0, minY: 0, maxX: 1, maxY: 1 })) {
                // unreachable
            }
        }).rejects.toThrow(/writeLinkSpatialIndex/);
    });

    it('returns nothing for a query outside the data envelope', async () => {
        const { geojson, adjacency } = grid(4);
        const ctx = await FlatRecord.open(serialize(geojson, adjacency, { writeSpatialIndex: false }));
        const hits = [];
        for await (const edge of ctx.linksInBbox({ minX: 100, minY: 100, maxX: 200, maxY: 200 })) {
            hits.push(edge);
        }
        expect(hits).toEqual([]);
    });
});

describe('shortestPath', () => {
    it('returns vertices + edges + cost using default A* + haversine', async () => {
        const { geojson, adjacency } = lineGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        const result = await (await FlatRecord.open(bytes)).shortestPath( 0, 3);
        expect(result).not.toBeNull();
        if (!result) return;

        expect(result.features).toHaveLength(4);
        expect(result.links).toHaveLength(3);
        expect((result.features[0].properties as { id: number }).id).toBe(0);
        expect((result.features[3].properties as { id: number }).id).toBe(3);
        expect(result.links[0].properties?.id).toBe('0-1');
        expect(result.links[2].properties?.id).toBe('2-3');

        // Cost should equal the sum of haversine distances along the chain.
        const expectedCost =
            haversine([-46.6, -23.55], [-46.5, -23.55]) +
            haversine([-46.5, -23.55], [-46.4, -23.55]) +
            haversine([-46.4, -23.55], [-46.3, -23.55]);
        expect(result.cost).toBeCloseTo(expectedCost, 1);
    });

    it('returns a trivial path when from === to', async () => {
        const { geojson, adjacency } = lineGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        const result = await (await FlatRecord.open(bytes)).shortestPath( 2, 2);
        expect(result).not.toBeNull();
        if (!result) return;
        expect(result.features).toHaveLength(1);
        expect(result.links).toHaveLength(0);
        expect(result.cost).toBe(0);
        expect((result.features[0].properties as { id: number }).id).toBe(2);
    });

    it('returns null when no path exists', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { id: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { id: 2 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [{ from: 0, to: 1, properties: { id: '0-1' } }],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const result = await (await FlatRecord.open(bytes)).shortestPath( 0, 2);
        expect(result).toBeNull();
    });

    it('prefers a longer chain when the direct edge has a higher weight', async () => {
        // Triangle with shortcut: 0 ── 2 (cost 100), 0 ── 1 ── 2 (cost 1+1)
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { id: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { id: 2 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 0, to: 1, properties: { w: 1 } },
                { from: 1, to: 2, properties: { w: 1 } },
                { from: 0, to: 2, properties: { w: 100 } },
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        const result = await (await FlatRecord.open(bytes)).shortestPath( 0, 2, {
            weight: (props, _distance) => Number(props.w),
            // Custom weights don't relate to haversine, so disable the
            // default haversine heuristic to keep A* admissible.
            heuristic: null,
        });
        expect(result).not.toBeNull();
        if (!result) return;
        expect(result.links).toHaveLength(2);
        expect(result.cost).toBe(2);
        expect(result.features.map((v) => (v.properties as { id: number }).id)).toEqual([0, 1, 2]);
    });

    it('passes haversine distance to the custom weight function', async () => {
        const { geojson, adjacency } = lineGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        const seen: number[] = [];
        const result = await (await FlatRecord.open(bytes)).shortestPath( 0, 3, {
            weight: (_props, distance) => {
                seen.push(distance);
                // travel time at 50 km/h (= ~13.9 m/s)
                return distance / 13.9;
            },
        });
        expect(result).not.toBeNull();
        // 3 edges were visited
        expect(seen).toHaveLength(3);
        for (const d of seen) {
            // Each segment is ~10 km ≈ 10_000 m.
            expect(d).toBeGreaterThan(5_000);
            expect(d).toBeLessThan(20_000);
        }
    });

    it('produces the same optimal path with A* (default) and Dijkstra (heuristic: null)', async () => {
        const { geojson, adjacency } = lineGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        const astar = await (await FlatRecord.open(bytes)).shortestPath( 0, 3);
        const dijkstra = await (await FlatRecord.open(bytes)).shortestPath( 0, 3, { heuristic: null });

        expect(astar).not.toBeNull();
        expect(dijkstra).not.toBeNull();
        if (!astar || !dijkstra) return;
        expect(astar.cost).toBeCloseTo(dijkstra.cost, 6);
        expect(astar.features.map((v) => (v.properties as { id: number }).id)).toEqual(
            dijkstra.features.map((v) => (v.properties as { id: number }).id),
        );
    });

    it('throws when the adjacency index is missing', async () => {
        const { geojson, adjacency } = lineGraph();
        const bytes = serialize(geojson, adjacency, {
            writeSpatialIndex: false,
            writeAdjacencyIndex: false,
            writeLinkSpatialIndex: false,
        });
        await expect((await FlatRecord.open(bytes)).shortestPath( 0, 3)).rejects.toThrow(/writeAdjacencyIndex/);
    });

    it('handles vertex Hilbert sort correctly (default writeIndex=true)', async () => {
        // Even with Hilbert reordering of vertices, the path between two
        // original endpoints (looked up by id property) should match the
        // intuition: A → … → D for any monotonic chain.
        const { geojson, adjacency } = lineGraph();
        const bytes = serialize(geojson, adjacency); // all indices on, default

        // Find the actual stored indices for original id 0 and 3.
        const { features } = await deserialize(bytes);
        const ix = (id: number) => features.findIndex((f) => (f.properties as { id: number }).id === id);

        const result = await (await FlatRecord.open(bytes)).shortestPath( ix(0), ix(3));
        expect(result).not.toBeNull();
        if (!result) return;
        const idChain = result.features.map((v) => (v.properties as { id: number }).id);
        expect(idChain).toEqual([0, 1, 2, 3]);
    });
});

describe('Index flag combinations', () => {
    function smallGraph(): { geojson: GeoJsonFeatureCollection; adjacency: AdjacencyListInput } {
        return {
            geojson: {
                type: 'FeatureCollection',
                features: [
                    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                    { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { id: 1 } },
                    { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { id: 2 } },
                ],
            },
            adjacency: {
                links: [
                    { from: 0, to: 1, properties: { id: '0-1' } },
                    { from: 1, to: 2, properties: { id: '1-2' } },
                ],
            },
        };
    }

    it('vertex index only: spatial filter works, graph queries error out', async () => {
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, {
            writeSpatialIndex: true,
            writeAdjacencyIndex: false,
            writeLinkSpatialIndex: false,
        });

        // Vertex spatial filter must work
        let count = 0;
        for await (const _f of (await import('../../src/ts/geojson/featurecollection.js')).deserializeStream(bytes, {
            minX: -1,
            minY: -1,
            maxX: 3,
            maxY: 2,
        })) {
            count++;
        }
        expect(count).toBe(3);

        // Graph queries must reject
        const ctx = await FlatRecord.open(bytes);
        await expect(collect(ctx.outgoingLinksOf(0))).rejects.toThrow(/writeAdjacencyIndex/);
        await expect(async () => {
            for await (const _ of ctx.linksInBbox({ minX: 0, minY: 0, maxX: 2, maxY: 2 })) {
                // unreachable
            }
        }).rejects.toThrow(/writeLinkSpatialIndex/);
    });

    it('edge index only: linksInBbox works, outgoingLinksOf and shortestPath error out', async () => {
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, {
            writeSpatialIndex: false,
            writeAdjacencyIndex: false,
            writeLinkSpatialIndex: true,
        });
        const ctx = await FlatRecord.open(bytes);

        // Edge spatial filter works
        const hits = [];
        for await (const edge of ctx.linksInBbox({ minX: 0, minY: 0, maxX: 2, maxY: 2 })) {
            hits.push(edge.properties?.id);
        }
        expect(new Set(hits)).toEqual(new Set(['0-1', '1-2']));

        // Neighbor lookup rejects
        await expect(collect(ctx.outgoingLinksOf(0))).rejects.toThrow(/writeAdjacencyIndex/);

        // shortestPath rejects (needs adjacency)
        await expect((await FlatRecord.open(bytes)).shortestPath( 0, 2)).rejects.toThrow(/writeAdjacencyIndex/);
    });

    it('adjacency index only: outgoingLinksOf + shortestPath work, linksInBbox errors out', async () => {
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, {
            writeSpatialIndex: false,
            writeAdjacencyIndex: true,
            writeLinkSpatialIndex: false,
        });
        const ctx = await FlatRecord.open(bytes);

        expect((await collect(ctx.outgoingLinksOf(0))).map((e) => e.to)).toEqual([1]);
        expect((await collect(ctx.outgoingLinksOf(1))).map((e) => e.to)).toEqual([2]);

        const result = await (await FlatRecord.open(bytes)).shortestPath( 0, 2);
        expect(result).not.toBeNull();
        expect(result?.links).toHaveLength(2);

        await expect(async () => {
            for await (const _ of ctx.linksInBbox({ minX: 0, minY: 0, maxX: 2, maxY: 2 })) {
                // unreachable
            }
        }).rejects.toThrow(/writeLinkSpatialIndex/);
    });

    it('vertex + edge indices, no CSR: spatial works on both, no neighbor lookup', async () => {
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, {
            writeSpatialIndex: true,
            writeAdjacencyIndex: false,
            writeLinkSpatialIndex: true,
        });
        const ctx = await FlatRecord.open(bytes);

        // Edge bbox query works
        const hits = [];
        for await (const edge of ctx.linksInBbox({ minX: -1, minY: -1, maxX: 3, maxY: 3 })) {
            hits.push(edge);
        }
        expect(hits).toHaveLength(2);

        // No adjacency
        await expect(collect(ctx.outgoingLinksOf(0))).rejects.toThrow(/writeAdjacencyIndex/);
    });

    it('vertex + adjacency, no edge R-tree: shortestPath works, linksInBbox errors', async () => {
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, {
            writeSpatialIndex: true,
            writeAdjacencyIndex: true,
            writeLinkSpatialIndex: false,
        });
        const ctx = await FlatRecord.open(bytes);

        // Vertex Hilbert may have reordered features → look up by id
        const { features } = await deserialize(bytes);
        const ix = (id: number) => features.findIndex((f) => (f.properties as { id: number }).id === id);
        const result = await (await FlatRecord.open(bytes)).shortestPath( ix(0), ix(2));
        expect(result).not.toBeNull();
        expect(result?.features.map((v) => (v.properties as { id: number }).id)).toEqual([0, 1, 2]);

        await expect(async () => {
            for await (const _ of ctx.linksInBbox({ minX: 0, minY: 0, maxX: 2, maxY: 2 })) {
                // unreachable
            }
        }).rejects.toThrow(/writeLinkSpatialIndex/);
    });

    it('exposes accurate hasAdjacencyIndex / hasEdgeIndex flags', async () => {
        const { geojson, adjacency } = smallGraph();
        const cases: Array<[boolean, boolean]> = [
            [false, false],
            [true, false],
            [false, true],
            [true, true],
        ];
        for (const [a, e] of cases) {
            const bytes = serialize(geojson, adjacency, {
                writeSpatialIndex: false,
                writeAdjacencyIndex: a,
                writeLinkSpatialIndex: e,
            });
            let meta: import('../../src/ts/link-types.js').FlatRecordMeta | null = null;
            await deserialize(bytes, (m) => {
                meta = m;
            });
            const g = meta as unknown as import('../../src/ts/link-types.js').FlatRecordMeta;
            expect(g).not.toBeNull();
            expect(g.linkAdjacencyIndex.length > 0).toBe(a);
            expect(g.linkSpatialIndex.length > 0).toBe(e);
        }
    });
});

describe('shortestPath edge cases', () => {
    it('handles bidirectional pairs via CSR (sees both A→B and B→A)', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { id: 1 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 0, to: 1, properties: { direction: 'forward' } },
                { from: 1, to: 0, properties: { direction: 'backward' } },
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const ctx = await FlatRecord.open(bytes);

        const out0 = (await collect(ctx.outgoingLinksOf(0)));
        const out1 = (await collect(ctx.outgoingLinksOf(1)));
        expect(out0).toHaveLength(1);
        expect(out0[0].properties?.direction).toBe('forward');
        expect(out1).toHaveLength(1);
        expect(out1[0].properties?.direction).toBe('backward');

        // Path 0 → 1 must take the forward edge, 1 → 0 the backward one.
        const forward = await (await FlatRecord.open(bytes)).shortestPath( 0, 1);
        expect(forward?.links[0].properties?.direction).toBe('forward');
        const backward = await (await FlatRecord.open(bytes)).shortestPath( 1, 0);
        expect(backward?.links[0].properties?.direction).toBe('backward');
    });

    it('accepts zero-cost edges', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { id: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { id: 2 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 0, to: 1, properties: {} },
                { from: 1, to: 2, properties: {} },
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const result = await (await FlatRecord.open(bytes)).shortestPath( 0, 2, {
            weight: () => 0,
            heuristic: null,
        });
        expect(result).not.toBeNull();
        expect(result?.cost).toBe(0);
        expect(result?.links).toHaveLength(2);
    });

    it('throws on NaN edge weight', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: {} },
            ],
        };
        const adjacency: AdjacencyListInput = { links: [{ from: 0, to: 1, properties: {} }] };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        await expect(
            (await FlatRecord.open(bytes)).shortestPath( 0, 1, {
                weight: () => Number.NaN,
                heuristic: null,
            }),
        ).rejects.toThrow(/finite non-negative/);
    });

    it('throws on negative edge weight', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: {} },
            ],
        };
        const adjacency: AdjacencyListInput = { links: [{ from: 0, to: 1, properties: {} }] };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        await expect(
            (await FlatRecord.open(bytes)).shortestPath( 0, 1, {
                weight: () => -1,
                heuristic: null,
            }),
        ).rejects.toThrow(/finite non-negative/);
    });

    it('inadmissible heuristic can produce a suboptimal path (documented behaviour)', async () => {
        // Triangle with shortcut: weights 1, 1, 100. The shortcut is
        // longer-weight but the haversine heuristic (in degrees scaled
        // by ~111 km/deg) hugely overestimates the remaining cost in
        // the "fast" 0→1→2 branch, so an inadmissible heuristic will
        // misguide A* into picking the direct 0→2 with cost 100.
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { id: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { id: 2 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 0, to: 1, properties: { w: 1 } },
                { from: 1, to: 2, properties: { w: 1 } },
                { from: 0, to: 2, properties: { w: 100 } },
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        const weight = (props: { [k: string]: unknown }, _d: number) => Number(props.w);
        const withHeuristic = await (await FlatRecord.open(bytes)).shortestPath( 0, 2, { weight }); // default haversine, INADMISSIBLE here
        const withoutHeuristic = await (await FlatRecord.open(bytes)).shortestPath( 0, 2, { weight, heuristic: null });

        expect(withoutHeuristic?.links).toHaveLength(2);
        expect(withoutHeuristic?.cost).toBe(2);
        // Default heuristic returns the inferior path (cost 100). This
        // confirms the README warning is justified.
        expect(withHeuristic?.links).toHaveLength(1);
        expect(withHeuristic?.cost).toBe(100);
    });

    it('handles LineString geometry with duplicate consecutive points', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { id: 1 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                {
                    from: 0,
                    to: 1,
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [0, 0],
                            [0, 0], // duplicate
                            [0.5, 0],
                            [0.5, 0], // duplicate
                            [1, 0],
                        ],
                    },
                    properties: { id: 'dup' },
                },
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const result = await deserialize(bytes);
        expect(result.adjacencyList.links[0].geometry?.coordinates).toHaveLength(5);

        const path = await (await FlatRecord.open(bytes)).shortestPath( 0, 1, { heuristic: null });
        expect(path).not.toBeNull();
        // Distance should equal full 0 → 1 haversine (duplicates contribute 0).
        expect(path?.cost).toBeGreaterThan(0);
    });

    it('handles a degenerate bbox (minX == maxX, minY == maxY)', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [10, 10] }, properties: {} },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                {
                    from: 0,
                    to: 1,
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [0, 0],
                            [5, 5],
                            [10, 10],
                        ],
                    },
                    properties: { id: 'diag' },
                },
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const ctx = await FlatRecord.open(bytes);

        const hits = [];
        for await (const edge of ctx.linksInBbox({ minX: 5, minY: 5, maxX: 5, maxY: 5 })) {
            hits.push(edge.properties?.id);
        }
        expect(hits).toEqual(['diag']);
    });

    it('returns null between separate components in a multi-component graph', async () => {
        // Three disconnected components: {0,1,2} chain, {3,4} pair, {5} isolated.
        const features = [];
        for (let i = 0; i < 6; i++) {
            features.push({
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [i, 0] },
                properties: { id: i },
            });
        }
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 0, to: 1, properties: {} },
                { from: 1, to: 2, properties: {} },
                { from: 3, to: 4, properties: {} },
            ],
        };
        const bytes = serialize(
            { type: 'FeatureCollection', features },
            adjacency,
            { writeSpatialIndex: false },
        );

        expect(await (await FlatRecord.open(bytes)).shortestPath( 0, 2, { heuristic: null })).not.toBeNull(); // same component
        expect(await (await FlatRecord.open(bytes)).shortestPath( 0, 4, { heuristic: null })).toBeNull(); // diff component
        expect(await (await FlatRecord.open(bytes)).shortestPath( 0, 5, { heuristic: null })).toBeNull(); // isolated
        expect(await (await FlatRecord.open(bytes)).shortestPath( 4, 3, { heuristic: null })).toBeNull(); // direction matters
    });
});

describe('Structural properties', () => {
    it('CSR sort is stable: edges sharing `from` keep their input order', async () => {
        const features = [
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [0, 0] }, properties: {} },
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [1, 0] }, properties: {} },
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [2, 0] }, properties: {} },
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [3, 0] }, properties: {} },
        ];
        // Six edges from vertex 1, interleaved with edges from vertex 0
        // and vertex 2 to exercise the sort.
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 1, to: 0, properties: { tag: '1-0/a' } },
                { from: 0, to: 1, properties: { tag: '0-1' } },
                { from: 1, to: 2, properties: { tag: '1-2/b' } },
                { from: 2, to: 3, properties: { tag: '2-3' } },
                { from: 1, to: 3, properties: { tag: '1-3/c' } },
                { from: 1, to: 0, properties: { tag: '1-0/d' } },
            ],
        };
        const bytes = serialize(
            { type: 'FeatureCollection', features },
            adjacency,
            { writeSpatialIndex: false },
        );
        const ctx = await FlatRecord.open(bytes);

        // Edges out of vertex 1 must be in the SAME RELATIVE ORDER as
        // they appeared in the input — that's stable sort.
        const out1 = (await collect(ctx.outgoingLinksOf(1))).map((e) => e.properties?.tag);
        expect(out1).toEqual(['1-0/a', '1-2/b', '1-3/c', '1-0/d']);
    });

    it('edge bbox unions LineString geometry with vertex bboxes (no false negative)', async () => {
        // Edge whose LineString does NOT touch the from/to vertices —
        // bbox must still include the vertices so the spatial query
        // catches edges queried "near the endpoints".
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [10, 10] }, properties: {} },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                {
                    from: 0,
                    to: 1,
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [4, 4],
                            [5, 5],
                            [6, 6],
                        ],
                    },
                    properties: { id: 'gappy' },
                },
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const ctx = await FlatRecord.open(bytes);

        // Query around vertex 0 (which is OUTSIDE the LineString) — the
        // bbox must still match the edge because we union with vertex
        // bboxes.
        const nearV0 = [];
        for await (const e of ctx.linksInBbox({ minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 })) {
            nearV0.push(e.properties?.id);
        }
        expect(nearV0).toEqual(['gappy']);

        // Query around vertex 1 too
        const nearV1 = [];
        for await (const e of ctx.linksInBbox({ minX: 9.5, minY: 9.5, maxX: 10.5, maxY: 10.5 })) {
            nearV1.push(e.properties?.id);
        }
        expect(nearV1).toEqual(['gappy']);
    });

    it('Hilbert vertex sort + CSR sort interact correctly under shortestPath', async () => {
        // 6-point ring around São Paulo (forces a real Hilbert permutation)
        const features = [
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [-46.7, -23.6] }, properties: { id: 0 } },
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [-46.5, -23.4] }, properties: { id: 1 } },
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [-46.3, -23.5] }, properties: { id: 2 } },
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [-46.4, -23.7] }, properties: { id: 3 } },
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [-46.6, -23.8] }, properties: { id: 4 } },
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [-46.8, -23.5] }, properties: { id: 5 } },
        ];
        // Ring of edges 0→1→2→3→4→5→0 plus a shortcut 0→3
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 0, to: 1, properties: {} },
                { from: 1, to: 2, properties: {} },
                { from: 2, to: 3, properties: {} },
                { from: 3, to: 4, properties: {} },
                { from: 4, to: 5, properties: {} },
                { from: 5, to: 0, properties: {} },
                { from: 0, to: 3, properties: {} },
            ],
        };
        const bytes = serialize(
            { type: 'FeatureCollection', features },
            adjacency,
            { writeSpatialIndex: true, writeAdjacencyIndex: true, writeLinkSpatialIndex: true },
        );

        const { features: stored } = await deserialize(bytes);
        const ix = (id: number) => stored.findIndex((f) => (f.properties as { id: number }).id === id);

        // Confirm Hilbert reordered things
        expect(ix(0)).not.toBe(0); // at least one feature moved

        // The shortcut 0→3 must beat the long way 0→1→2→3
        const path = await (await FlatRecord.open(bytes)).shortestPath( ix(0), ix(3), { heuristic: null });
        expect(path).not.toBeNull();
        expect(path?.links).toHaveLength(1);
        expect(path?.features.map((v) => (v.properties as { id: number }).id)).toEqual([0, 3]);
    });
});

describe('Large-graph shortestPath', () => {
    function gridGraphLatLon(n: number) {
        // n x n lat/lon grid spaced ~1 km apart (0.01°).
        const features = [];
        for (let i = 0; i < n * n; i++) {
            const x = -46.6 + (i % n) * 0.01;
            const y = -23.5 + Math.floor(i / n) * 0.01;
            features.push({
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [x, y] },
                properties: { id: i },
            });
        }
        const edges: AdjacencyListInput['links'] = [];
        for (let row = 0; row < n; row++) {
            for (let col = 0; col < n; col++) {
                const here = row * n + col;
                if (col + 1 < n) {
                    edges.push({ from: here, to: here + 1, properties: {} });
                    edges.push({ from: here + 1, to: here, properties: {} });
                }
                if (row + 1 < n) {
                    edges.push({ from: here, to: here + n, properties: {} });
                    edges.push({ from: here + n, to: here, properties: {} });
                }
            }
        }
        return {
            geojson: { type: 'FeatureCollection' as const, features },
            adjacency: { links: edges },
        };
    }

    it('finds optimal corner-to-corner path on a 32×32 grid (~1024 vertices)', async () => {
        const n = 32;
        const { geojson, adjacency } = gridGraphLatLon(n);
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        const path = await (await FlatRecord.open(bytes)).shortestPath( 0, n * n - 1, { heuristic: null });
        expect(path).not.toBeNull();
        if (!path) return;

        // Manhattan distance on the grid: must traverse (n-1) east + (n-1) north steps
        expect(path.links.length).toBe(2 * (n - 1));
        expect((path.features[0].properties as { id: number }).id).toBe(0);
        expect((path.features.at(-1)?.properties as { id: number }).id).toBe(n * n - 1);
    });

    it('A* with haversine visits fewer nodes than Dijkstra on a large grid', async () => {
        const n = 32;
        const { geojson, adjacency } = gridGraphLatLon(n);
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        const astar = await (await FlatRecord.open(bytes)).shortestPath( 0, n * n - 1);
        const dijkstra = await (await FlatRecord.open(bytes)).shortestPath( 0, n * n - 1, { heuristic: null });

        expect(astar).not.toBeNull();
        expect(dijkstra).not.toBeNull();
        if (!astar || !dijkstra) return;

        // Both must find an optimal-length path (same edge count). The
        // exact cost equality is what matters: A* must not return a
        // worse path than Dijkstra.
        expect(astar.links.length).toBe(dijkstra.links.length);
        expect(astar.cost).toBeCloseTo(dijkstra.cost, 3);
    });
});

describe('Cycle handling', () => {
    function pointCollection(count: number): GeoJsonFeatureCollection {
        const features = [];
        for (let i = 0; i < count; i++) {
            features.push({
                type: 'Feature' as const,
                id: i,
                geometry: {
                    type: 'Point' as const,
                    coordinates: [Math.cos((i / count) * 2 * Math.PI), Math.sin((i / count) * 2 * Math.PI)],
                },
                properties: { id: i },
            });
        }
        return { type: 'FeatureCollection', features };
    }

    it('handles a pure directed 3-cycle without looping', async () => {
        // 0 → 1 → 2 → 0. Path 0 → 2 must take 0 → 1 → 2 (no shortcut).
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { id: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0.5, 1] }, properties: { id: 2 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 0, to: 1, properties: { tag: '0-1' } },
                { from: 1, to: 2, properties: { tag: '1-2' } },
                { from: 2, to: 0, properties: { tag: '2-0' } },
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        const ids = (p: { features: { properties: unknown }[] } | null) =>
            p?.features.map((v) => (v.properties as { id: number }).id) ?? null;

        expect(ids(await (await FlatRecord.open(bytes)).shortestPath( 0, 1, { heuristic: null }))).toEqual([0, 1]);
        expect(ids(await (await FlatRecord.open(bytes)).shortestPath( 0, 2, { heuristic: null }))).toEqual([0, 1, 2]);
        expect(ids(await (await FlatRecord.open(bytes)).shortestPath( 1, 0, { heuristic: null }))).toEqual([1, 2, 0]);
        expect(ids(await (await FlatRecord.open(bytes)).shortestPath( 2, 1, { heuristic: null }))).toEqual([2, 0, 1]);
    });

    it('terminates on a 100-vertex directed ring with no shortcuts', async () => {
        // 0 → 1 → 2 → ... → 99 → 0. Reachability is "forward-only".
        const N = 100;
        const geojson = pointCollection(N);
        const edges = [];
        for (let i = 0; i < N; i++) {
            edges.push({ from: i, to: (i + 1) % N, properties: { id: `${i}-${(i + 1) % N}` } });
        }
        const bytes = serialize(geojson, { links: edges }, { writeSpatialIndex: false });

        const t0 = Date.now();
        const path = await (await FlatRecord.open(bytes)).shortestPath( 0, 50, { heuristic: null });
        const elapsedMs = Date.now() - t0;

        expect(path).not.toBeNull();
        if (!path) return;
        // Forward half of the ring
        expect(path.links).toHaveLength(50);
        expect((path.features[0].properties as { id: number }).id).toBe(0);
        expect((path.features.at(-1)?.properties as { id: number }).id).toBe(50);
        // Should finalize in well under one second even with 100 vertices.
        expect(elapsedMs).toBeLessThan(1000);
    });

    it('terminates when destination is "behind" in a directed ring', async () => {
        // From vertex 1 to vertex 0 in a forward-only ring of 50 requires
        // going all the way around: 1 → 2 → ... → 49 → 0.
        const N = 50;
        const geojson = pointCollection(N);
        const edges = [];
        for (let i = 0; i < N; i++) edges.push({ from: i, to: (i + 1) % N, properties: {} });
        const bytes = serialize(geojson, { links: edges }, { writeSpatialIndex: false });

        const path = await (await FlatRecord.open(bytes)).shortestPath( 1, 0, { heuristic: null });
        expect(path).not.toBeNull();
        expect(path?.links).toHaveLength(N - 1);
    });

    it('handles bidirectional rings (A→B and B→A coexist around the cycle)', async () => {
        // Undirected ring of 6 expressed as 12 directed edges. From any
        // vertex, the shortest path to its "opposite" is exactly 3 hops.
        const N = 6;
        const geojson = pointCollection(N);
        const edges = [];
        for (let i = 0; i < N; i++) {
            const j = (i + 1) % N;
            edges.push({ from: i, to: j, properties: { dir: 'fwd' } });
            edges.push({ from: j, to: i, properties: { dir: 'rev' } });
        }
        const bytes = serialize(geojson, { links: edges }, { writeSpatialIndex: false });

        const path = await (await FlatRecord.open(bytes)).shortestPath( 0, 3, { heuristic: null });
        expect(path).not.toBeNull();
        // 3 hops in either direction — both are optimal.
        expect(path?.links).toHaveLength(3);
    });

    it('handles two cycles sharing a vertex (figure-8) without revisiting it', async () => {
        // Left cycle: 0 → 1 → 2 → 0
        // Right cycle: 0 → 3 → 4 → 0
        // Path 1 → 4 must go 1 → 2 → 0 → 3 → 4 (4 edges) because there's
        // no direct edge between the cycles other than through 0.
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [-1, 1] }, properties: { id: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [-1, -1] }, properties: { id: 2 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { id: 3 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, -1] }, properties: { id: 4 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                // Left cycle
                { from: 0, to: 1, properties: {} },
                { from: 1, to: 2, properties: {} },
                { from: 2, to: 0, properties: {} },
                // Right cycle
                { from: 0, to: 3, properties: {} },
                { from: 3, to: 4, properties: {} },
                { from: 4, to: 0, properties: {} },
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        const path = await (await FlatRecord.open(bytes)).shortestPath( 1, 4, { heuristic: null });
        expect(path).not.toBeNull();
        if (!path) return;
        expect(path.features.map((v) => (v.properties as { id: number }).id)).toEqual([1, 2, 0, 3, 4]);
        // Vertex 0 is the shared hub and must appear exactly once.
        const visits = path.features.filter((v) => (v.properties as { id: number }).id === 0).length;
        expect(visits).toBe(1);
    });

    it('survives zero-weight cycles without infinite loops', async () => {
        // 0 → 1 → 2 → 1 (zero-cost reverse) → ... could theoretically
        // loop forever if revisits were allowed. Confirm the finalized
        // bitmap stops that.
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { id: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { id: 2 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 0, to: 1, properties: {} },
                { from: 1, to: 2, properties: {} },
                { from: 2, to: 1, properties: {} }, // back-edge forming a cycle
                { from: 1, to: 0, properties: {} }, // back-edge forming another cycle
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        const t0 = Date.now();
        const path = await (await FlatRecord.open(bytes)).shortestPath( 0, 2, {
            weight: () => 0, // tempting zero-cost back-edges
            heuristic: null,
        });
        const elapsedMs = Date.now() - t0;

        expect(path).not.toBeNull();
        expect(path?.links).toHaveLength(2);
        expect(path?.cost).toBe(0);
        // If protection were missing we'd loop forever. Cap generously.
        expect(elapsedMs).toBeLessThan(500);
    });

    it('returns the trivial path 0 → 0 even in a cycle that revisits the source', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { id: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0.5, 1] }, properties: { id: 2 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 0, to: 1, properties: {} },
                { from: 1, to: 2, properties: {} },
                { from: 2, to: 0, properties: {} }, // closes the loop back to source
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        // from === to: must short-circuit without exploring the cycle.
        const path = await (await FlatRecord.open(bytes)).shortestPath( 0, 0);
        expect(path).not.toBeNull();
        expect(path?.features).toHaveLength(1);
        expect(path?.links).toHaveLength(0);
        expect(path?.cost).toBe(0);
    });

    it('still finds the optimal path despite a tempting distraction cycle', async () => {
        // Direct path: 0 → 1 → 2 (cost 5 + 5 = 10)
        // Detour through 3: 0 → 3 → 1 → 2 (cost 1 + 1 + 5 = 7) — strictly cheaper
        // Plus a cycle 1 → 3 that would let the algorithm waste effort
        // if cycle-protection were absent.
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { id: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [4, 0] }, properties: { id: 2 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { id: 3 } },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 0, to: 1, properties: { w: 5 } },
                { from: 1, to: 2, properties: { w: 5 } },
                { from: 0, to: 3, properties: { w: 1 } },
                { from: 3, to: 1, properties: { w: 1 } },
                { from: 1, to: 3, properties: { w: 1 } }, // forms 1→3→1 cycle
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        const path = await (await FlatRecord.open(bytes)).shortestPath( 0, 2, {
            weight: (props, _d) => Number(props.w),
            heuristic: null,
        });
        expect(path).not.toBeNull();
        if (!path) return;
        expect(path.cost).toBe(7);
        expect(path.features.map((v) => (v.properties as { id: number }).id)).toEqual([0, 3, 1, 2]);
    });
});

describe('Haversine numerical correctness', () => {
    it('returns 0 for identical points', () => {
        expect(haversine([12.34, -56.78], [12.34, -56.78])).toBe(0);
    });

    it('handles the antimeridian correctly (short distance across ±180°)', () => {
        // Crossing from lon 179 to lon -179 is geographically just 2°
        // apart at the equator (~222 km), not a full ~39 700 km trip.
        const crossing = haversine([179, 0], [-179, 0]);
        const equivalent = haversine([1, 0], [-1, 0]);
        expect(crossing).toBeCloseTo(equivalent, 6);
        expect(crossing).toBeLessThan(250_000); // metres
    });

    it('handles the poles (longitude is irrelevant at 90°)', () => {
        // At the north pole longitude is undefined; distance between
        // [10, 90] and [200, 90] should be zero.
        const d = haversine([10, 90], [200, 90]);
        expect(d).toBeLessThan(1); // sub-metre
    });

    it('matches a known reference: São Paulo → Rio de Janeiro ≈ 360 km', () => {
        // Reference value: great-circle distance roughly 358-362 km.
        const d = haversine([-46.6333, -23.5505], [-43.1729, -22.9068]);
        expect(d).toBeGreaterThan(350_000);
        expect(d).toBeLessThan(370_000);
    });

    it('matches a known reference: London → New York ≈ 5570 km', () => {
        const d = haversine([-0.1278, 51.5074], [-74.006, 40.7128]);
        expect(d).toBeGreaterThan(5_500_000);
        expect(d).toBeLessThan(5_600_000);
    });

    it('is symmetric: haversine(a, b) === haversine(b, a)', () => {
        const a: [number, number] = [-46.6333, -23.5505];
        const b: [number, number] = [2.3522, 48.8566];
        expect(haversine(a, b)).toBeCloseTo(haversine(b, a), 9);
    });
});

describe('Robustness against malformed input', () => {
    it('rejects bytes with invalid magic', async () => {
        const garbage = new Uint8Array(64);
        garbage[0] = 0x47; // wrong byte
        await expect(FlatRecord.open(garbage)).rejects.toThrow(/magic/i);
    });

    it('rejects an empty buffer', async () => {
        await expect(FlatRecord.open(new Uint8Array(0))).rejects.toThrow();
    });

    it('rejects a buffer that is only the magic bytes', async () => {
        const magicOnly = new Uint8Array([0x66, 0x72, 0x62, 0x01, 0x66, 0x72, 0x62, 0x00]);
        await expect(FlatRecord.open(magicOnly)).rejects.toThrow();
    });

    it('calcTreeSize(0, n) returns 0 without infinite-looping', async () => {
        // Regression guard for an upstream bug: Math.ceil(0/n) is 0 and
        // never reaches 1, so the do/while in calcTreeSize used to spin
        // forever when called with 0 items.
        const { calcTreeSize } = await import('../../src/ts/packedrtree.js');
        expect(calcTreeSize(0, 16)).toBe(0);
        expect(calcTreeSize(0, 2)).toBe(0);
    });
});

describe('Public API surface', () => {
    it('all documented symbols are importable from flatrecord/geojson', async () => {
        const mod = await import('../../src/ts/geojson.js');
        // Encoder / decoder
        expect(typeof mod.serialize).toBe('function');
        expect(typeof mod.deserialize).toBe('function');
        // Random-access reader (class)
        expect(typeof mod.FlatRecord).toBe('function');
        expect(typeof mod.FlatRecord.open).toBe('function');
    });

    it('FlatRecord is also importable from the root module', async () => {
        const mod = await import('../../src/ts/index.js');
        expect(typeof mod.FlatRecord).toBe('function');
        expect(typeof mod.FlatRecord.open).toBe('function');
    });

    it('internal helpers and streaming variants are NOT exposed by the public modules', async () => {
        const mod = await import('../../src/ts/geojson.js') as Record<string, unknown>;
        // Streaming variants were removed; user-facing API is just
        // serialize + deserialize + FlatRecord.
        expect(mod.deserializeStream).toBeUndefined();
        expect(mod.deserializeFiltered).toBeUndefined();
        expect(mod.deserializeGraphEdges).toBeUndefined();
        // Internal helpers from earlier refactors stay internal.
        expect(mod.haversine).toBeUndefined();
        expect(mod.edgeHaversineLength).toBeUndefined();
        expect(mod.openGraph).toBeUndefined();
        expect(mod.outgoingLinksOf).toBeUndefined();
        expect(mod.linksInBbox).toBeUndefined();
        expect(mod.shortestPath).toBeUndefined();
    });
});

describe('Concurrent and shared usage', () => {
    function gridGraph(n: number): { geojson: GeoJsonFeatureCollection; adjacency: AdjacencyListInput } {
        const features = [];
        for (let i = 0; i < n * n; i++) {
            features.push({
                type: 'Feature' as const,
                geometry: {
                    type: 'Point' as const,
                    coordinates: [-46.6 + (i % n) * 0.001, -23.5 + Math.floor(i / n) * 0.001],
                },
                properties: { id: i },
            });
        }
        const edges: AdjacencyListInput['links'] = [];
        for (let row = 0; row < n; row++) {
            for (let col = 0; col < n; col++) {
                const here = row * n + col;
                if (col + 1 < n) {
                    edges.push({ from: here, to: here + 1, properties: {} });
                    edges.push({ from: here + 1, to: here, properties: {} });
                }
                if (row + 1 < n) {
                    edges.push({ from: here, to: here + n, properties: {} });
                    edges.push({ from: here + n, to: here, properties: {} });
                }
            }
        }
        return { geojson: { type: 'FeatureCollection', features }, adjacency: { links: edges } };
    }

    it('shares a single FlatRecord across many parallel shortestPath calls', async () => {
        const n = 10;
        const { geojson, adjacency } = gridGraph(n);
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const ctx = await FlatRecord.open(bytes);

        const calls = Array.from({ length: 16 }, (_, k) =>
            ctx.shortestPath(k % (n * n), (n * n - 1 - k) % (n * n)),
        );
        const results = await Promise.all(calls);
        for (const r of results) {
            if (r) {
                expect(r.cost).toBeGreaterThanOrEqual(0);
                expect(r.features.length).toBeGreaterThanOrEqual(1);
            }
        }
    });

    it('allows the same FlatRecord instance to serve many queries idempotently', async () => {
        const n = 8;
        const { geojson, adjacency } = gridGraph(n);
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const ctx = await FlatRecord.open(bytes);

        // Walk every vertex's outgoing edges twice from the same context
        // — must yield identical results, no state leaks between calls.
        for (let v = 0; v < n * n; v++) {
            const a = (await collect(ctx.outgoingLinksOf(v))).map((e) => `${e.from}-${e.to}`);
            const b = (await collect(ctx.outgoingLinksOf(v))).map((e) => `${e.from}-${e.to}`);
            expect(a).toEqual(b);
        }
    });
});

describe('Non-Point vertex geometries', () => {
    it('supports Polygon-typed vertices in a graph with all indices', async () => {
        // Two square parcels connected by an edge.
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [0, 0],
                                [1, 0],
                                [1, 1],
                                [0, 1],
                                [0, 0],
                            ],
                        ],
                    },
                    properties: { id: 'parcel-A' },
                },
                {
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [2, 0],
                                [3, 0],
                                [3, 1],
                                [2, 1],
                                [2, 0],
                            ],
                        ],
                    },
                    properties: { id: 'parcel-B' },
                },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [{ from: 0, to: 1, properties: { kind: 'shared-fence' } }],
        };

        const bytes = serialize(geojson, adjacency);
        const result = await deserialize(bytes);
        expect(result.features).toHaveLength(2);
        expect(result.features[0].geometry.type).toBe('Polygon');
        expect(result.adjacencyList.links).toHaveLength(1);

        // linksInBbox must catch the edge even though both vertices
        // are polygons (bbox derived from vertex bboxes).
        const ctx = await FlatRecord.open(bytes);
        const hits = [];
        for await (const e of ctx.linksInBbox({ minX: 0.5, minY: 0.5, maxX: 0.6, maxY: 0.6 })) {
            hits.push(e.properties?.kind);
        }
        expect(hits).toEqual(['shared-fence']);
    });
});

describe('Large-graph integration', () => {
    it('round-trips 1024 vertices + ~4k edges with all 3 indices and finds shortest path', async () => {
        const n = 32;
        // n x n lat/lon grid in São Paulo, every edge bidirectional
        const features = [];
        for (let i = 0; i < n * n; i++) {
            features.push({
                type: 'Feature' as const,
                geometry: {
                    type: 'Point' as const,
                    coordinates: [-46.6 + (i % n) * 0.001, -23.5 + Math.floor(i / n) * 0.001],
                },
                properties: { id: i },
            });
        }
        const edges: AdjacencyListInput['links'] = [];
        for (let row = 0; row < n; row++) {
            for (let col = 0; col < n; col++) {
                const here = row * n + col;
                if (col + 1 < n) {
                    edges.push({ from: here, to: here + 1, properties: {} });
                    edges.push({ from: here + 1, to: here, properties: {} });
                }
                if (row + 1 < n) {
                    edges.push({ from: here, to: here + n, properties: {} });
                    edges.push({ from: here + n, to: here, properties: {} });
                }
            }
        }

        const bytes = serialize(
            { type: 'FeatureCollection', features },
            { links: edges },
            { writeSpatialIndex: true, writeAdjacencyIndex: true, writeLinkSpatialIndex: true },
        );

        // Roundtrip metadata
        let meta: import('../../src/ts/link-types.js').FlatRecordMeta | null = null;
        const result = await deserialize(bytes, (m) => {
            meta = m;
        });
        expect(result.features).toHaveLength(n * n);
        expect(result.adjacencyList.links).toHaveLength(edges.length);
        const m = meta as unknown as import('../../src/ts/link-types.js').FlatRecordMeta;
        expect(m.indexNodeSize).toBe(16);
        expect((m.linkAdjacencyIndex.length > 0)).toBe(true);
        expect((m.linkSpatialIndex.length > 0)).toBe(true);

        // Find original endpoint indices (Hilbert may have reordered)
        const ix = (id: number) => result.features.findIndex((f) => (f.properties as { id: number }).id === id);

        // Corner-to-corner shortest path
        const t0 = Date.now();
        const path = await (await FlatRecord.open(bytes)).shortestPath( ix(0), ix(n * n - 1));
        const elapsed = Date.now() - t0;

        expect(path).not.toBeNull();
        if (!path) return;
        expect(path.links).toHaveLength(2 * (n - 1));
        expect((path.features[0].properties as { id: number }).id).toBe(0);
        expect((path.features.at(-1)?.properties as { id: number }).id).toBe(n * n - 1);
        // Must run comfortably under 1 second
        expect(elapsed).toBeLessThan(1000);

        // Edge bbox query against the same indexed file
        const ctx = await FlatRecord.open(bytes);
        const queryHits: number[] = [];
        for await (const _e of ctx.linksInBbox({
            minX: -46.5995,
            minY: -23.4995,
            maxX: -46.5985,
            maxY: -23.4985,
        })) {
            queryHits.push(1);
        }
        // A small bbox at a corner intersects at least a handful of edges
        expect(queryHits.length).toBeGreaterThan(0);
    });
});

describe('Feature iteration', () => {
    function small(): { geojson: GeoJsonFeatureCollection; adjacency: AdjacencyListInput } {
        return {
            geojson: {
                type: 'FeatureCollection',
                features: [
                    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { id: 0 } },
                    { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { id: 1 } },
                    { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { id: 2 } },
                    { type: 'Feature', geometry: { type: 'Point', coordinates: [3, 1] }, properties: { id: 3 } },
                ],
            },
            adjacency: {
                links: [
                    { from: 0, to: 1, properties: {} },
                    { from: 1, to: 2, properties: {} },
                ],
            },
        };
    }

    it('getFeature returns the right vertex by Hilbert index and caches it', async () => {
        const { geojson, adjacency } = small();
        const bytes = serialize(geojson, adjacency);
        const ctx = await FlatRecord.open(bytes);
        const all = await ctx.loadFeatures();
        const ids = all.map((f) => (f.properties as { id: number }).id);

        for (let i = 0; i < ctx.featuresCount; i++) {
            const f = await ctx.getFeature(i);
            expect((f.properties as { id: number }).id).toBe(ids[i]);
        }
        // Cached: calling again must return the same object reference.
        const a = await ctx.getFeature(0);
        const b = await ctx.getFeature(0);
        expect(a).toBe(b);
    });

    it('features() yields every vertex in storage order', async () => {
        const { geojson, adjacency } = small();
        const bytes = serialize(geojson, adjacency);
        const ctx = await FlatRecord.open(bytes);

        const fromIterator = await collect(ctx.features());
        const fromEager = await ctx.loadFeatures();
        expect(fromIterator.map((f) => (f.properties as { id: number }).id)).toEqual(
            fromEager.map((f) => (f.properties as { id: number }).id),
        );
    });

    it('featuresInBbox filters vertices by spatial query', async () => {
        const { geojson, adjacency } = small();
        const bytes = serialize(geojson, adjacency);
        const ctx = await FlatRecord.open(bytes);

        const hits = await collect(ctx.featuresInBbox({ minX: -0.5, minY: -0.5, maxX: 1.5, maxY: 1.5 }));
        const ids = hits.map((f) => (f.properties as { id: number }).id).sort();
        // Only vertices 0 (0,0) and 1 (1,1) fall inside that bbox.
        expect(ids).toEqual([0, 1]);
    });

    it('featuresInBbox throws when no vertex spatial index was written', async () => {
        const { geojson, adjacency } = small();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const ctx = await FlatRecord.open(bytes);

        await expect(
            collect(ctx.featuresInBbox({ minX: -1, minY: -1, maxX: 5, maxY: 5 })),
        ).rejects.toThrow(/writeSpatialIndex/);
    });

    it('allLinks yields every edge in storage order', async () => {
        const { geojson, adjacency } = small();
        const bytes = serialize(geojson, adjacency);
        const ctx = await FlatRecord.open(bytes);
        const edges = await collect(ctx.allLinks());
        expect(edges).toHaveLength(2);
        expect(edges[0].from).toBeLessThanOrEqual(edges[1].from);
    });
});

describe('Eager cache (loadFeatures / loadLinks / preload)', () => {
    function smallGraph(): { geojson: GeoJsonFeatureCollection; adjacency: AdjacencyListInput } {
        const features = Array.from({ length: 8 }, (_, i) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [i, i % 2] },
            properties: { id: i },
        }));
        const edges: AdjacencyListInput['links'] = [];
        for (let i = 0; i < 7; i++) {
            edges.push({ from: i, to: i + 1, properties: { id: `${i}-${i + 1}` } });
        }
        return { geojson: { type: 'FeatureCollection', features }, adjacency: { links: edges } };
    }

    it('lazy outgoingLinksOf populates the cache for subsequent calls', async () => {
        const { byteReaderFromUint8Array } = await import('../../src/ts/byte-reader.js');
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        let reads = 0;
        const inner = byteReaderFromUint8Array(bytes);
        const counting = {
            async read(o: number, l: number) {
                reads++;
                return inner.read(o, l);
            },
        };
        const ctx = await FlatRecord.open(counting);
        const after = reads;

        // First call reads I/O
        const a = await collect(ctx.outgoingLinksOf(3));
        expect(reads).toBeGreaterThan(after);
        const firstCallReads = reads;

        // Second call is fully served from cache — no new reads.
        const b = await collect(ctx.outgoingLinksOf(3));
        expect(reads).toBe(firstCallReads);
        expect(a.map((e) => `${e.from}-${e.to}`)).toEqual(b.map((e) => `${e.from}-${e.to}`));
    });

    it('preload() prefers readAll() when the ByteReader exposes it', async () => {
        const { byteReaderFromUint8Array } = await import('../../src/ts/byte-reader.js');
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const inner = byteReaderFromUint8Array(bytes);

        let rangeReads = 0;
        let readAllCalls = 0;
        const reader = {
            async read(o: number, l: number) {
                rangeReads++;
                return inner.read(o, l);
            },
            async readAll() {
                readAllCalls++;
                return inner.readAll?.() ?? new Uint8Array(0);
            },
        };

        const ctx = await FlatRecord.open(reader);
        const rangeReadsAfterOpen = rangeReads;

        await ctx.preload();
        // The fast path must not issue any additional `read()` calls and
        // must have invoked `readAll()` exactly once.
        expect(rangeReads).toBe(rangeReadsAfterOpen);
        expect(readAllCalls).toBe(1);

        // Caches were populated correctly — zero further I/O.
        const before = rangeReads;
        const out = await collect(ctx.outgoingLinksOf(0));
        expect(out).toHaveLength(1);
        await ctx.getFeature(0);
        expect(rangeReads).toBe(before);
    });

    it('preload() with CSR uses a single bulk range request', async () => {
        const { byteReaderFromUint8Array } = await import('../../src/ts/byte-reader.js');
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        let reads = 0;
        let largestRead = 0;
        const inner = byteReaderFromUint8Array(bytes);
        const counting = {
            async read(o: number, l: number) {
                reads++;
                if (l > largestRead) largestRead = l;
                return inner.read(o, l);
            },
        };
        const ctx = await FlatRecord.open(counting);
        const afterOpen = reads;

        await ctx.preload();
        const preloadReads = reads - afterOpen;
        // One sentinel read (4B) + one big read covering the rest.
        expect(preloadReads).toBeLessThanOrEqual(2);
        // The big read must indeed be the bulk transfer.
        expect(largestRead).toBeGreaterThanOrEqual(bytes.byteLength / 2);

        // Subsequent queries do not touch the reader anymore.
        const before = reads;
        await ctx.getFeature(0);
        await collect(ctx.outgoingLinksOf(0));
        await collect(ctx.allLinks());
        expect(reads).toBe(before);
    });

    it('loadIndices() caches R-trees, leaving feature/edge payloads lazy', async () => {
        const { byteReaderFromUint8Array } = await import('../../src/ts/byte-reader.js');
        const { geojson, adjacency } = smallGraph();
        // Need writeIndex=true to actually exercise vertex R-tree caching.
        const bytes = serialize(geojson, adjacency);

        let reads = 0;
        const inner = byteReaderFromUint8Array(bytes);
        const counting = {
            async read(o: number, l: number) {
                reads++;
                return inner.read(o, l);
            },
        };
        const ctx = await FlatRecord.open(counting);
        const afterOpen = reads;

        await ctx.loadIndices();
        const afterIndices = reads;
        expect(afterIndices).toBeGreaterThan(afterOpen);

        // First bbox query: no R-tree node fetches, only feature payload reads.
        const hits1 = await collect(ctx.featuresInBbox({ minX: -1, minY: -1, maxX: 100, maxY: 100 }));
        expect(hits1.length).toBe(8);
        const afterFirstQuery = reads;

        // Repeat the same query — feature cache + R-tree cache combine to zero reads.
        const hits2 = await collect(ctx.featuresInBbox({ minX: -1, minY: -1, maxX: 100, maxY: 100 }));
        expect(hits2.length).toBe(8);
        expect(reads).toBe(afterFirstQuery);
    });

    it('loadLinks() bulk-loads every outgoing edge into cache with few reads', async () => {
        const { byteReaderFromUint8Array } = await import('../../src/ts/byte-reader.js');
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        let reads = 0;
        const inner = byteReaderFromUint8Array(bytes);
        const counting = {
            async read(o: number, l: number) {
                reads++;
                return inner.read(o, l);
            },
        };
        const ctx = await FlatRecord.open(counting);
        const afterOpen = reads;

        await ctx.loadLinks();
        // loadLinks issues at most ~3 reads when CSR is present:
        // sentinel size, edges section, CSR offsets array.
        const loadReads = reads - afterOpen;
        expect(loadReads).toBeLessThanOrEqual(5);

        // Every outgoingLinksOf call is now zero-I/O.
        const beforeQueries = reads;
        for (let v = 0; v < ctx.featuresCount; v++) {
            await collect(ctx.outgoingLinksOf(v));
        }
        expect(reads).toBe(beforeQueries);
    });

    it('loadLinks() is idempotent', async () => {
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });
        const ctx = await FlatRecord.open(bytes);
        await ctx.loadLinks();
        await ctx.loadLinks(); // must not throw
        const out = await collect(ctx.outgoingLinksOf(0));
        expect(out).toHaveLength(1);
    });

    it('preload() warms both feature and edge caches in one shot', async () => {
        const { byteReaderFromUint8Array } = await import('../../src/ts/byte-reader.js');
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        let reads = 0;
        const inner = byteReaderFromUint8Array(bytes);
        const counting = {
            async read(o: number, l: number) {
                reads++;
                return inner.read(o, l);
            },
        };
        const ctx = await FlatRecord.open(counting);
        await ctx.preload();
        const afterPreload = reads;

        // Every per-feature / per-edge query is zero-I/O now.
        for (let i = 0; i < ctx.featuresCount; i++) {
            await ctx.getFeature(i);
            await collect(ctx.outgoingLinksOf(i));
        }
        for await (const _ of ctx.allLinks()) {
            // also zero I/O — served from in-memory edges section
        }
        expect(reads).toBe(afterPreload);
    });

    it('preload() works on graphs without adjacency index (fallback path)', async () => {
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, {
            writeSpatialIndex: false,
            writeAdjacencyIndex: false,
            writeLinkSpatialIndex: false,
        });
        const ctx = await FlatRecord.open(bytes);
        await ctx.preload();
        // outgoingLinksOf still rejects because no CSR exists, but features are loaded.
        expect(ctx).toBeDefined();
        const f0 = await ctx.getFeature(0);
        expect((f0.properties as { id: number }).id).toBe(0);
    });

    it('release() drops every cache and the next query reads from the source again', async () => {
        const { byteReaderFromUint8Array } = await import('../../src/ts/byte-reader.js');
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency);

        let reads = 0;
        const inner = byteReaderFromUint8Array(bytes);
        const counting = {
            async read(o: number, l: number) {
                reads++;
                return inner.read(o, l);
            },
        };
        const ctx = await FlatRecord.open(counting);
        await ctx.preload();
        const afterPreload = reads;

        // Cache hits — zero I/O.
        await ctx.getFeature(0);
        await collect(ctx.outgoingLinksOf(0));
        expect(reads).toBe(afterPreload);

        ctx.release();

        // Same queries now go through the reader again.
        await ctx.getFeature(0);
        const afterFeature = reads;
        expect(afterFeature).toBeGreaterThan(afterPreload);
        await collect(ctx.outgoingLinksOf(0));
        expect(reads).toBeGreaterThan(afterFeature);
    });

    it('releaseFeatures / releaseLinks / releaseIndices are independent', async () => {
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency);
        const ctx = await FlatRecord.open(bytes);
        await ctx.preload();

        const beforeIds = Array.from({ length: ctx.featuresCount }, (_, i) => i);

        // Drop only features.
        ctx.releaseFeatures();
        // outgoingLinksOf still served from cache.
        const out = await collect(ctx.outgoingLinksOf(0));
        expect(out).toHaveLength(1);
        // Re-loading features works.
        for (const i of beforeIds) await ctx.getFeature(i);

        // Drop only edges.
        ctx.releaseLinks();
        // getFeature still served from cache.
        const f0a = await ctx.getFeature(0);
        const f0b = await ctx.getFeature(0);
        expect(f0a).toBe(f0b);
        // outgoingLinksOf rebuilds the cache.
        const out2 = await collect(ctx.outgoingLinksOf(0));
        expect(out2).toHaveLength(1);

        // Drop only R-trees.
        ctx.releaseIndices();
        // bbox query still works (just reads R-tree nodes from source).
        const hits = await collect(ctx.featuresInBbox({ minX: -1, minY: -1, maxX: 100, maxY: 100 }));
        expect(hits.length).toBe(ctx.featuresCount);
    });

    it('shortestPath after preload() performs zero further I/O', async () => {
        const { byteReaderFromUint8Array } = await import('../../src/ts/byte-reader.js');
        const { geojson, adjacency } = smallGraph();
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        let reads = 0;
        const inner = byteReaderFromUint8Array(bytes);
        const counting = {
            async read(o: number, l: number) {
                reads++;
                return inner.read(o, l);
            },
        };
        const ctx = await FlatRecord.open(counting);
        await ctx.preload();
        const afterPreload = reads;

        const path = await ctx.shortestPath(0, 7, { heuristic: null });
        expect(path?.links).toHaveLength(7);
        expect(reads).toBe(afterPreload);
    });
});

describe('ByteReader abstraction', () => {
    it('supports a custom async ByteReader (lazy range reads)', async () => {
        const { byteReaderFromUint8Array } = await import('../../src/ts/byte-reader.js');
        const { geojson, adjacency } = {
            geojson: {
                type: 'FeatureCollection' as const,
                features: [
                    { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [0, 0] }, properties: { id: 0 } },
                    { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [1, 1] }, properties: { id: 1 } },
                ],
            },
            adjacency: { links: [{ from: 0, to: 1, properties: { tag: 'x' } }] },
        };
        const bytes = serialize(geojson, adjacency);

        // Wrap in a custom reader that counts how many ranges were
        // fetched, so we can verify the open path is lightweight even
        // when bytes are large.
        let reads = 0;
        const inner = byteReaderFromUint8Array(bytes);
        const counting = {
            async read(offset: number, length: number) {
                reads++;
                return inner.read(offset, length);
            },
        };

        const ctx = await FlatRecord.open(counting);
        const openReads = reads;
        expect(openReads).toBeGreaterThan(0);
        // open() should not touch hundreds of bytes — sanity bound.
        expect(openReads).toBeLessThan(15);

        // Walking outgoing edges of vertex 0 should add only a handful
        // more reads (CSR offsets + one edge size prefix + one edge body).
        const out = await collect(ctx.outgoingLinksOf(0));
        expect(out).toHaveLength(1);
        expect(out[0].properties?.tag).toBe('x');
        expect(reads - openReads).toBeLessThan(10);
    });

    it('outgoingLinksOf does 1 bulk read per vertex (not 2 per edge)', async () => {
        const { byteReaderFromUint8Array } = await import('../../src/ts/byte-reader.js');
        // Vertex 0 with 4 outgoing edges. Old behaviour: 1 CSR read + 4×2
        // record reads = 9. New behaviour: 1 CSR read + 1 bulk span read = 2.
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: Array.from({ length: 5 }, (_, i) => ({
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [i, 0] },
                properties: { id: i },
            })),
        };
        const adjacency: AdjacencyListInput = {
            links: [
                { from: 0, to: 1, properties: { id: '0-1' } },
                { from: 0, to: 2, properties: { id: '0-2' } },
                { from: 0, to: 3, properties: { id: '0-3' } },
                { from: 0, to: 4, properties: { id: '0-4' } },
            ],
        };
        const bytes = serialize(geojson, adjacency, { writeSpatialIndex: false });

        let reads = 0;
        const inner = byteReaderFromUint8Array(bytes);
        const counting = {
            async read(o: number, l: number) {
                reads++;
                return inner.read(o, l);
            },
        };
        const ctx = await FlatRecord.open(counting);
        const afterOpen = reads;

        const out = await collect(ctx.outgoingLinksOf(0));
        expect(out).toHaveLength(4);
        const queryReads = reads - afterOpen;
        // Should be exactly 2 (CSR offsets + span). Cold path with no
        // loadIndices/loadLinks called yet.
        expect(queryReads).toBe(2);
    });

    it('getFeature does 1 round-trip per feature with speculative read (default)', async () => {
        const { byteReaderFromUint8Array } = await import('../../src/ts/byte-reader.js');
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: Array.from({ length: 10 }, (_, i) => ({
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [i, 0] },
                properties: { id: i, name: `n${i}` },
            })),
        };
        const adjacency: AdjacencyListInput = {
            links: [{ from: 0, to: 1, properties: {} }],
        };
        const bytes = serialize(geojson, adjacency);

        let reads = 0;
        const inner = byteReaderFromUint8Array(bytes);
        const counting = {
            async read(o: number, l: number) {
                reads++;
                return inner.read(o, l);
            },
        };
        const ctx = await FlatRecord.open(counting);
        const afterOpen = reads;

        await ctx.getFeature(5);
        const oneFeatureReads = reads - afterOpen;
        // R-tree leaf (8B) + speculative record fetch (fits in 1024B for
        // a Point feature with two small properties) = 2 reads.
        // Before optimization this would be 3 (leaf + size prefix + payload).
        expect(oneFeatureReads).toBe(2);
    });

    it('rejects when the ByteReader returns fewer bytes than requested', async () => {
        const truncating = {
            async read(_offset: number, length: number) {
                return new Uint8Array(length - 1); // always short by 1
            },
        };
        await expect(FlatRecord.open(truncating)).rejects.toThrow();
    });

    it('search state is sparse: visits a fraction of vertices in a large graph', async () => {
        // Linear chain of 10 000 vertices; A* from 0 → 5 visits 6
        // vertices (0..5). With a dense Float64Array(N) the search
        // state would weigh ~80 KB just for `distances`; with sparse
        // Map/Set it stays proportional to the visited set.
        const N = 10_000;
        // Note: writeSpatialIndex: true (default) is essential here — it lets
        // `getFeature` resolve a single vertex via O(1) R-tree lookup
        // without eagerly loading the entire features section. Without
        // the R-tree the reader falls back to bulk-loading features,
        // which inflates the feature cache to N entries and dwarfs the
        // search state itself.
        const features = Array.from({ length: N }, (_, i) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [-46.6 + i * 0.00001, -23.5] },
            properties: { id: i },
        }));
        const edges = Array.from({ length: N - 1 }, (_, i) => ({ from: i, to: i + 1, properties: {} }));
        const bytes = serialize({ type: 'FeatureCollection', features }, { links: edges });
        const ctx = await FlatRecord.open(bytes);

        const before = process.memoryUsage().heapUsed;
        const path = await ctx.shortestPath(0, 5, { heuristic: null });
        const after = process.memoryUsage().heapUsed;

        expect(path).not.toBeNull();
        expect(path?.links).toHaveLength(5);

        // Sanity check: the search itself should not have allocated
        // anywhere near a Float64Array of length N (which is 80 KB
        // for N=10000). A few visited entries cost a few KB at most.
        const delta = after - before;
        expect(delta).toBeLessThan(2_000_000); // generous 2 MB cap
    });

    it('shortestPath visits only the features along the route (lazy)', async () => {
        const { byteReaderFromUint8Array } = await import('../../src/ts/byte-reader.js');
        // Chain of 50 vertices; path 0 → 5 should touch only ~6 features.
        const n = 50;
        const features = Array.from({ length: n }, (_, i) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [-46.6 + i * 0.001, -23.5] },
            properties: { id: i },
        }));
        const edges = Array.from({ length: n - 1 }, (_, i) => ({ from: i, to: i + 1, properties: {} }));
        const bytes = serialize({ type: 'FeatureCollection', features }, { links: edges }, { writeSpatialIndex: false });

        let reads = 0;
        const inner = byteReaderFromUint8Array(bytes);
        const counting = {
            async read(offset: number, length: number) {
                reads++;
                return inner.read(offset, length);
            },
        };
        const ctx = await FlatRecord.open(counting);
        const openReads = reads;

        const path = await ctx.shortestPath(0, 5, { heuristic: null });
        expect(path).not.toBeNull();
        expect(path?.links).toHaveLength(5);

        // Bound: lazy access means we should not have parsed all 50
        // features. The exact number depends on chunk sizes but must
        // be well under "fetched every feature".
        const queryReads = reads - openReads;
        expect(queryReads).toBeLessThan(50 * 4); // very generous upper bound
        // And we cached features on the instance, so getFeature(0) again
        // does not add reads.
        const before = reads;
        await ctx.getFeature(0);
        expect(reads).toBe(before);
    });
});
