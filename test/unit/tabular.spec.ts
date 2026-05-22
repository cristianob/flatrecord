/**
 * Tabular mode (`table` / `graph`) — files with no per-feature geometry.
 *
 * Two ways to produce tabular data:
 *   1. Pass a plain `Row[]` to `serialize(rows, …)`.
 *   2. Pass a GeoJSON FeatureCollection whose every feature has
 *      `geometry: null`.
 *
 * `deserialize` returns `{ mode, rows, adjacencyList }` for either
 * shape — symmetric to the input.
 */

import { describe, expect, it } from 'vitest';
import { deserialize, FlatRecord, serialize, type Row } from '../../src/ts/geojson.js';
import type { AdjacencyListInput } from '../../src/ts/link-types.js';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const v of iter) out.push(v);
    return out;
}

describe('tabular mode — Row[] input', () => {
    const rows: Row[] = [
        { name: 'Alice', score: 10, active: true },
        { name: 'Bob', score: 20, active: false },
        { name: 'Carol', score: 30, active: true },
    ];

    it('round-trips a plain Row[] through table mode', async () => {
        const bytes = serialize(rows);
        const result = await deserialize(bytes);
        expect(result.mode).toBe('table');
        if (result.mode === 'table' || result.mode === 'graph') {
            expect(result.rows).toEqual(rows);
            expect(result.adjacencyList.links).toEqual([]);
        } else {
            throw new Error('expected table mode');
        }
    });

    it('reports table mode on FlatRecord.open', async () => {
        const bytes = serialize(rows);
        const fr = await FlatRecord.open(bytes);
        expect(fr.mode).toBe('table');
        expect(fr.hasGeometry).toBe(false);
        expect(fr.hasLinks).toBe(false);
        expect(fr.featuresCount).toBe(3);
    });

    it('exposes derived meta to the metadata callback', async () => {
        const bytes = serialize(rows);
        let meta: import('../../src/ts/link-types.js').FlatRecordMeta | null = null;
        await deserialize(bytes, (m) => {
            meta = m;
        });
        expect(meta).not.toBeNull();
        expect(meta!.mode).toBe('table');
        expect(meta!.hasGeometry).toBe(false);
        expect(meta!.hasLinks).toBe(false);
        expect(meta!.featuresCount).toBe(3);
        expect(meta!.linksCount).toBe(0);
    });

    it('supports property indices on tabular files', async () => {
        const bytes = serialize(rows, undefined, {
            writeColumnIndex: { features: ['name', 'score', 'active'] },
        });
        const fr = await FlatRecord.open(bytes);
        expect(fr.mode).toBe('table');

        const text = await collect(fr.findFeaturesByText('name', 'alice'));
        expect(text.map((h) => h.feature.properties.name)).toEqual(['Alice']);

        const high = await collect(fr.findFeaturesByValue('score', { gte: 20 }));
        expect(high.map((f) => f.properties.name).sort()).toEqual(['Bob', 'Carol']);

        const actives = await collect(fr.findFeaturesByValue('active', { eq: true }));
        expect(actives.map((f) => f.properties.name).sort()).toEqual(['Alice', 'Carol']);
    });

    it('lookup-driven helpers (featureIndexBy) work on tabular files', async () => {
        const bytes = serialize(rows, undefined, {
            writeColumnIndex: { features: ['name'] },
        });
        const fr = await FlatRecord.open(bytes);
        const idx = await fr.featureIndexBy({ column: 'name', value: 'Bob' });
        expect(idx).toBe(1);
    });

    it('rejects spatial queries on tabular files with a descriptive error', async () => {
        const bytes = serialize(rows);
        const fr = await FlatRecord.open(bytes);
        await expect(collect(fr.featuresInBbox({ minX: 0, minY: 0, maxX: 1, maxY: 1 }))).rejects.toThrow(
            /no geometry/i,
        );
    });

    it('rejects link queries on table mode files', async () => {
        const bytes = serialize(rows);
        const fr = await FlatRecord.open(bytes);
        await expect(collect(fr.outgoingLinksOf(0))).rejects.toThrow(/no links/i);
        await expect(collect(fr.allLinks())).resolves.toEqual([]);
    });

    it('preloads tabular files in a single bulk read', async () => {
        const bytes = serialize(rows, undefined, {
            writeColumnIndex: { features: ['name'] },
        });
        const fr = await FlatRecord.open(bytes);
        await fr.preload();
        const text = await collect(fr.findFeaturesByText('name', 'carol'));
        expect(text).toHaveLength(1);
    });
});

describe('tabular mode — FeatureCollection with null geometries', () => {
    const geojson = {
        type: 'FeatureCollection' as const,
        features: [
            { type: 'Feature' as const, geometry: null, properties: { id: 'a', flag: true } },
            { type: 'Feature' as const, geometry: null, properties: { id: 'b', flag: false } },
        ],
    };

    it('round-trips and emits rows on deserialize', async () => {
        // biome-ignore lint/suspicious/noExplicitAny: tests permit ambiguous geom
        const bytes = serialize(geojson as any);
        const fr = await FlatRecord.open(bytes);
        expect(fr.mode).toBe('table');
        // biome-ignore lint/suspicious/noExplicitAny: see above
        const result = await deserialize(bytes as any);
        if (result.mode !== 'table' && result.mode !== 'graph') throw new Error('expected tabular');
        expect(result.rows).toEqual(geojson.features.map((f) => f.properties));
    });
});

describe('graph mode — tabular features + links', () => {
    const rows: Row[] = [
        { id: 'A', kind: 'hub' },
        { id: 'B', kind: 'leaf' },
        { id: 'C', kind: 'leaf' },
        { id: 'D', kind: 'leaf' },
    ];
    const adjacency: AdjacencyListInput = {
        links: [
            { from: 0, to: 1, properties: { weight: 1.0 } },
            { from: 0, to: 2, properties: { weight: 2.5 } },
            { from: 0, to: 3, properties: { weight: 0.5 } },
            { from: 1, to: 2, properties: { weight: 1.5 } },
        ],
    };

    it('reports graph mode (no geometry, has links)', async () => {
        const bytes = serialize(rows, adjacency);
        const fr = await FlatRecord.open(bytes);
        expect(fr.mode).toBe('graph');
        expect(fr.hasGeometry).toBe(false);
        expect(fr.hasLinks).toBe(true);
        expect(fr.featuresCount).toBe(4);
        expect(fr.linksCount).toBe(4);
    });

    it('round-trips features (as rows) + links via deserialize', async () => {
        const bytes = serialize(rows, adjacency);
        const result = await deserialize(bytes);
        expect(result.mode).toBe('graph');
        if (result.mode !== 'graph') throw new Error('expected graph mode');
        expect(result.rows).toEqual(rows);
        expect(result.adjacencyList.links).toHaveLength(4);
        expect(result.adjacencyList.links.map((l) => [l.from, l.to])).toEqual([
            [0, 1],
            [0, 2],
            [0, 3],
            [1, 2],
        ]);
    });

    it('outgoingLinksOf works without geometry', async () => {
        const bytes = serialize(rows, adjacency);
        const fr = await FlatRecord.open(bytes);
        const out = await collect(fr.outgoingLinksOf(0));
        expect(out.map((l) => l.to).sort()).toEqual([1, 2, 3]);
    });

    it('shortestPath uses hop count by default in graph mode (no geometry)', async () => {
        const bytes = serialize(rows, adjacency);
        const fr = await FlatRecord.open(bytes);
        // No options ⇒ default weight is `() => 1`, default heuristic
        // is null (Dijkstra). Path 0 → 2 has direct link, cost 1.
        const path = await fr.shortestPath(0, 2);
        expect(path).not.toBeNull();
        expect(path?.features).toHaveLength(2);
        expect(path?.cost).toBe(1);
    });

    it('custom weight overrides the hop-count default', async () => {
        const bytes = serialize(rows, adjacency);
        const fr = await FlatRecord.open(bytes);
        const path = await fr.shortestPath(0, 2, {
            weight: (props, _d) => Number(props.weight ?? 1),
        });
        expect(path).not.toBeNull();
        expect(path?.cost).toBe(2.5);
    });

    it('rejects featuresInBbox / linksInBbox (no spatial indices)', async () => {
        const bytes = serialize(rows, adjacency);
        const fr = await FlatRecord.open(bytes);
        await expect(collect(fr.featuresInBbox({ minX: 0, minY: 0, maxX: 1, maxY: 1 }))).rejects.toThrow(
            /no geometry/i,
        );
        await expect(collect(fr.linksInBbox({ minX: 0, minY: 0, maxX: 1, maxY: 1 }))).rejects.toThrow(
            /no link spatial index/i,
        );
    });

    it('supports property indices on links in graph mode', async () => {
        const bytes = serialize(rows, adjacency, {
            writeColumnIndex: { features: ['id'], links: ['weight'] },
        });
        const fr = await FlatRecord.open(bytes);
        const heavy = await collect(fr.findLinksByValue('weight', { gte: 2 }));
        expect(heavy).toHaveLength(1);
        expect(heavy[0].properties.weight).toBe(2.5);
    });

    it('lookup by feature id flows into shortestPath', async () => {
        const bytes = serialize(rows, adjacency, {
            writeColumnIndex: { features: ['id'] },
        });
        const fr = await FlatRecord.open(bytes);
        const path = await fr.shortestPath(
            { column: 'id', value: 'A' },
            { column: 'id', value: 'C' },
            { weight: (p, _d) => Number(p.weight ?? 1) },
        );
        expect(path).not.toBeNull();
        expect(path?.features[0].properties.id).toBe('A');
        expect(path?.features[path.features.length - 1].properties.id).toBe('C');
    });
});

describe('graph mode — shortestPath defaults & edge cases', () => {
    const rows: Row[] = [
        { id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' },
    ];

    it('default weight is `() => 1` (hop count) on graph mode', async () => {
        // Path A→C: direct (1 hop, cost 100) vs A→B→C (2 hops, costs 1 each).
        // With default weight, hop count wins (cost 2 < unit-weight applies to
        // every link, so direct = 1 link = 1 cost).
        const bytes = serialize(rows, {
            links: [
                { from: 0, to: 1, properties: {} },
                { from: 0, to: 2, properties: { detour: true } },
                { from: 1, to: 2, properties: {} },
            ],
        });
        const fr = await FlatRecord.open(bytes);
        const path = await fr.shortestPath(0, 2);
        expect(path).not.toBeNull();
        // Direct A→C wins with default weight (1 hop).
        expect(path?.features.map((f) => f.properties.id)).toEqual(['A', 'C']);
        expect(path?.cost).toBe(1);
    });

    it('default heuristic is null on graph mode (no haversine without coordinates)', async () => {
        // Same path 0→2; confirm result matches Dijkstra (the only sensible mode).
        const bytes = serialize(rows, {
            links: [
                { from: 0, to: 1, properties: {} },
                { from: 1, to: 2, properties: {} },
                { from: 0, to: 2, properties: {} },
            ],
        });
        const fr = await FlatRecord.open(bytes);
        const withDefault = await fr.shortestPath(0, 2);
        const withDijkstra = await fr.shortestPath(0, 2, { heuristic: null });
        expect(withDefault?.cost).toBe(withDijkstra?.cost);
        expect(withDefault?.features.map((f) => f.properties.id)).toEqual(
            withDijkstra?.features.map((f) => f.properties.id),
        );
    });

    it('custom heuristic is honoured on graph mode (user knows their domain)', async () => {
        // 0→1→2: cost 2 (hop count default).
        const bytes = serialize(rows, {
            links: [
                { from: 0, to: 1, properties: {} },
                { from: 1, to: 2, properties: {} },
            ],
        });
        const fr = await FlatRecord.open(bytes);
        // Trivial admissible heuristic always 0 = Dijkstra. Trust the caller.
        const calls: number[] = [];
        await fr.shortestPath(0, 2, {
            heuristic: (f, _t) => {
                calls.push(Number(f.properties.id?.charCodeAt(0) ?? 0));
                return 0;
            },
        });
        // Heuristic was invoked at least once (custom honoured).
        expect(calls.length).toBeGreaterThan(0);
    });

    it('weight signature is (properties, distance) — properties first', async () => {
        const bytes = serialize(rows, {
            links: [
                { from: 0, to: 1, properties: { cost: 10 } },
                { from: 0, to: 2, properties: { cost: 1 } },
                { from: 2, to: 1, properties: { cost: 1 } },
            ],
        });
        const fr = await FlatRecord.open(bytes);
        const seenProps: unknown[] = [];
        const seenDist: number[] = [];
        const path = await fr.shortestPath(0, 1, {
            weight: (props, distance) => {
                seenProps.push(props);
                seenDist.push(distance);
                return Number(props.cost);
            },
        });
        expect(path).not.toBeNull();
        expect(path?.cost).toBe(2);   // 0→2→1 (1 + 1) cheaper than 0→1 (10)
        expect(seenProps.length).toBeGreaterThan(0);
        // distance is always 0 on graph mode (no coordinates)
        expect(seenDist.every((d) => d === 0)).toBe(true);
    });

    it('returns null on a disconnected target', async () => {
        const bytes = serialize(rows, {
            links: [
                { from: 0, to: 1, properties: {} },
                { from: 1, to: 2, properties: {} },
                // 3 and 4 are isolated.
            ],
        });
        const fr = await FlatRecord.open(bytes);
        const path = await fr.shortestPath(0, 4);
        expect(path).toBeNull();
    });

    it('returns trivial single-feature result when from === to', async () => {
        const bytes = serialize(rows, {
            links: [{ from: 0, to: 1, properties: {} }],
        });
        const fr = await FlatRecord.open(bytes);
        const path = await fr.shortestPath(2, 2);
        expect(path).not.toBeNull();
        expect(path?.features).toHaveLength(1);
        expect(path?.links).toHaveLength(0);
        expect(path?.cost).toBe(0);
    });

    it('rejects NaN / Infinity / negative weights', async () => {
        const bytes = serialize(rows, {
            links: [{ from: 0, to: 1, properties: {} }],
        });
        const fr = await FlatRecord.open(bytes);
        await expect(fr.shortestPath(0, 1, { weight: () => Number.NaN })).rejects.toThrow(
            /Link weight must be/,
        );
        await expect(
            fr.shortestPath(0, 1, { weight: () => Number.POSITIVE_INFINITY }),
        ).rejects.toThrow(/Link weight must be/);
        await expect(fr.shortestPath(0, 1, { weight: () => -1 })).rejects.toThrow(/Link weight must be/);
    });

    it('handles zero-weight cycles without infinite loops', async () => {
        // 0 → 1 → 0 → 2 cycle. Default hop count makes cycles non-tempting.
        const bytes = serialize(rows, {
            links: [
                { from: 0, to: 1, properties: {} },
                { from: 1, to: 0, properties: {} },
                { from: 0, to: 2, properties: {} },
            ],
        });
        const fr = await FlatRecord.open(bytes);
        const path = await fr.shortestPath(0, 2, { weight: () => 0 });
        // Cost is 0 but the path must terminate.
        expect(path).not.toBeNull();
        expect(path?.cost).toBe(0);
    });

    it('handles a long chain with default hop-count weight', async () => {
        // 100-feature chain.
        const N = 100;
        const chainRows: Row[] = Array.from({ length: N }, (_, i) => ({ id: `n${i}` }));
        const links = Array.from({ length: N - 1 }, (_, i) => ({
            from: i,
            to: i + 1,
            properties: {},
        }));
        // writeSpatialIndex auto-disabled in graph mode; Hilbert sort skipped.
        const bytes = serialize(chainRows, { links });
        const fr = await FlatRecord.open(bytes);
        const path = await fr.shortestPath(0, N - 1);
        expect(path).not.toBeNull();
        expect(path?.cost).toBe(N - 1);
        expect(path?.features).toHaveLength(N);
    });

    it('shortcuts via {column, value} lookup on both endpoints', async () => {
        const bytes = serialize(rows, {
            links: [
                { from: 0, to: 1, properties: {} },
                { from: 1, to: 2, properties: {} },
                { from: 2, to: 3, properties: {} },
                { from: 3, to: 4, properties: {} },
            ],
        }, {
            writeColumnIndex: { features: ['id'] },
        });
        const fr = await FlatRecord.open(bytes);
        const path = await fr.shortestPath(
            { column: 'id', value: 'A' },
            { column: 'id', value: 'E' },
        );
        expect(path).not.toBeNull();
        expect(path?.features.map((f) => f.properties.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
        expect(path?.cost).toBe(4);
    });

    it('bidirectional links via two directed entries', async () => {
        // Undirected pair A↔B.
        const bytes = serialize(rows, {
            links: [
                { from: 0, to: 1, properties: { dir: 'fwd' } },
                { from: 1, to: 0, properties: { dir: 'rev' } },
            ],
        });
        const fr = await FlatRecord.open(bytes);
        const ab = await fr.shortestPath(0, 1);
        const ba = await fr.shortestPath(1, 0);
        expect(ab?.cost).toBe(1);
        expect(ba?.cost).toBe(1);
        expect(ab?.links[0].properties.dir).toBe('fwd');
        expect(ba?.links[0].properties.dir).toBe('rev');
    });

    it('preserves stable link order via writeAdjacencyIndex', async () => {
        const bytes = serialize(rows, {
            links: [
                { from: 0, to: 1, properties: { tag: 'first' } },
                { from: 0, to: 2, properties: { tag: 'second' } },
                { from: 0, to: 3, properties: { tag: 'third' } },
            ],
        });
        const fr = await FlatRecord.open(bytes);
        const out: string[] = [];
        for await (const l of fr.outgoingLinksOf(0)) out.push(String(l.properties.tag));
        expect(out).toEqual(['first', 'second', 'third']);
    });

    it('shortestPath respects custom heuristic on graph mode (admissible identity)', async () => {
        const bytes = serialize(rows, {
            links: [
                { from: 0, to: 1, properties: {} },
                { from: 1, to: 2, properties: {} },
                { from: 0, to: 2, properties: {} },
            ],
        });
        const fr = await FlatRecord.open(bytes);
        // Always-0 heuristic = Dijkstra equivalent; A* must still find the
        // optimal cost-1 path (0→2 direct) under default hop-count weight.
        const path = await fr.shortestPath(0, 2, { heuristic: (_f, _t) => 0 });
        expect(path?.cost).toBe(1);
    });
});

describe('mode permutations — tabular × graph index flags', () => {
    interface Flags {
        hasLinks: boolean;
        writeAdjacencyIndex: boolean;
        writeColumnIndexFeatures: boolean;
        writeColumnIndexLinks: boolean;
    }

    const ROWS: Row[] = [
        { code: 'X', tier: 1, premium: true },
        { code: 'Y', tier: 2, premium: false },
        { code: 'Z', tier: 3, premium: true },
    ];
    const ADJ: AdjacencyListInput = {
        links: [
            { from: 0, to: 1, properties: { weight: 10, kind: 'fast' } },
            { from: 0, to: 2, properties: { weight: 5, kind: 'slow' } },
            { from: 1, to: 2, properties: { weight: 7, kind: 'fast' } },
        ],
    };

    function build(f: Flags): Uint8Array {
        return serialize(ROWS, f.hasLinks ? ADJ : undefined, {
            writeAdjacencyIndex: f.writeAdjacencyIndex,
            writeColumnIndex: {
                features: f.writeColumnIndexFeatures ? ['code', 'tier', 'premium'] : undefined,
                links: f.writeColumnIndexLinks ? ['weight', 'kind'] : undefined,
            },
        });
    }

    const BOOL = [false, true] as const;
    const PERMS: Flags[] = [];
    for (const hasLinks of BOOL)
        for (const writeAdjacencyIndex of BOOL)
            for (const writeColumnIndexFeatures of BOOL)
                for (const writeColumnIndexLinks of BOOL)
                    PERMS.push({
                        hasLinks,
                        writeAdjacencyIndex,
                        writeColumnIndexFeatures,
                        writeColumnIndexLinks,
                    });

    function label(f: Flags): string {
        return [
            f.hasLinks ? 'links' : '·',
            f.writeAdjacencyIndex ? 'CSR' : '·',
            f.writeColumnIndexFeatures ? 'F-Prop' : '·',
            f.writeColumnIndexLinks ? 'L-Prop' : '·',
        ].join('/');
    }

    for (const flags of PERMS) {
        it(`${label(flags)} — mode inferred + round-trip + feature index`, async () => {
            const bytes = build(flags);
            const fr = await FlatRecord.open(bytes);

            // Mode inference
            expect(fr.hasGeometry).toBe(false);
            expect(fr.hasLinks).toBe(flags.hasLinks);
            expect(fr.mode).toBe(flags.hasLinks ? 'graph' : 'table');

            // Round-trip
            const result = await deserialize(bytes);
            if (result.mode !== 'table' && result.mode !== 'graph') {
                throw new Error(`expected tabular, got ${result.mode}`);
            }
            expect(result.rows).toEqual(ROWS);
            expect(result.adjacencyList.links.length).toBe(flags.hasLinks ? ADJ.links.length : 0);

            // Property index queries: succeed when declared, fail otherwise
            if (flags.writeColumnIndexFeatures) {
                const hits = await collect(fr.findFeaturesByText('code', 'X'));
                expect(hits).toHaveLength(1);
            } else {
                await expect(collect(fr.findFeaturesByText('code', 'X'))).rejects.toThrow(
                    /column index/i,
                );
            }

            // outgoingLinksOf prereq: hasLinks + writeAdjacencyIndex
            if (flags.hasLinks && flags.writeAdjacencyIndex) {
                const out = await collect(fr.outgoingLinksOf(0));
                expect(out).toHaveLength(2);
            } else if (!flags.hasLinks) {
                await expect(collect(fr.outgoingLinksOf(0))).rejects.toThrow(/no links/i);
            } else {
                await expect(collect(fr.outgoingLinksOf(0))).rejects.toThrow(/adjacency/i);
            }
        });
    }
});
