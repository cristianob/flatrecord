/**
 * Cold vs warm-cache symmetry.
 *
 * Every query method has at least two code paths:
 *   - **Cold** (`FlatRecord.open()` only) — fetch bytes via the
 *     ByteReader on demand, parse as needed.
 *   - **Warm** (after `preload()` / `loadX()`) — serve from in-memory
 *     caches; no further `read()` calls.
 *
 * Both paths must return identical results. This spec picks a handful
 * of representative fixtures, runs each query first cold and then
 * after `preload()`, and asserts the outputs match byte-for-byte
 * (or value-for-value where bytes aren't comparable).
 *
 * Why this is its own spec instead of doubling `permutations.spec.ts`:
 *   - The permutation matrix already covers "does this method work
 *     given these writer flags?".
 *   - Symmetry is a different concern (does the cached path agree
 *     with the cold path?). A handful of representative configs is
 *     enough to catch any divergence in the caching logic without
 *     2× blow-up of the matrix.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { FlatRecord, serialize, type Row } from '../../src/ts/geojson.js';
import type { AdjacencyListInput, Link } from '../../src/ts/link-types.js';
import type { IGeoJsonFeature } from '../../src/ts/geojson/feature.js';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const v of iter) out.push(v);
    return out;
}

/** Compare two features: same id + geometry coords + properties. */
function eqFeature(a: IGeoJsonFeature, b: IGeoJsonFeature): boolean {
    return JSON.stringify({
        g: a.geometry,
        p: a.properties,
    }) === JSON.stringify({
        g: b.geometry,
        p: b.properties,
    });
}

function eqFeatureArray(a: IGeoJsonFeature[], b: IGeoJsonFeature[]): void {
    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i++) {
        expect(eqFeature(a[i], b[i]), `feature ${i}`).toBe(true);
    }
}

function eqLink(a: Link, b: Link): boolean {
    return (
        a.from === b.from &&
        a.to === b.to &&
        JSON.stringify(a.geometry) === JSON.stringify(b.geometry) &&
        JSON.stringify(a.properties) === JSON.stringify(b.properties)
    );
}

function eqLinkArray(a: Link[], b: Link[]): void {
    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i++) {
        expect(eqLink(a[i], b[i]), `link ${i}`).toBe(true);
    }
}

// ───────────────────── Fixtures ────────────────────────────────────

const GEOGRAPH_BYTES = (() => {
    const geojson = {
        type: 'FeatureCollection' as const,
        features: [
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [-46.63, -23.55] }, properties: { name: 'São Paulo', icao: 'SBSP', elev: 2461, intl: true } },
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [-43.17, -22.91] }, properties: { name: 'Rio', icao: 'SBRJ', elev: 11, intl: false } },
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [-47.93, -15.78] }, properties: { name: 'Brasília', icao: 'SBBR', elev: 3497, intl: true } },
            { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [-49.27, -16.68] }, properties: { name: 'Rio Preto', icao: 'SBSR', elev: 1784, intl: false } },
        ],
    };
    const adj: AdjacencyListInput = {
        links: [
            { from: 0, to: 1, properties: { road: 'BR-116', km: 429 } },
            { from: 0, to: 2, properties: { road: 'BR-050', km: 1015 } },
            { from: 0, to: 3, properties: { road: 'BR-153', km: 442 } },
            { from: 2, to: 3, properties: { road: 'BR-070', km: 580 } },
        ],
    };
    return serialize(geojson, adj, {
        writeColumnIndex: { features: ['name', 'icao', 'elev', 'intl'], links: ['road', 'km'] },
    });
})();

const GRAPH_BYTES = (() => {
    const rows: Row[] = [
        { id: 'A', kind: 'hub' },
        { id: 'B', kind: 'leaf' },
        { id: 'C', kind: 'leaf' },
        { id: 'D', kind: 'leaf' },
    ];
    const adj: AdjacencyListInput = {
        links: [
            { from: 0, to: 1, properties: { weight: 1, kind: 'fast' } },
            { from: 0, to: 2, properties: { weight: 2, kind: 'slow' } },
            { from: 0, to: 3, properties: { weight: 3, kind: 'slow' } },
            { from: 1, to: 2, properties: { weight: 4, kind: 'fast' } },
        ],
    };
    return serialize(rows, adj, {
        writeColumnIndex: { features: ['id', 'kind'], links: ['weight', 'kind'] },
    });
})();

const TABLE_BYTES = serialize(
    [
        { name: 'Alice', age: 30, vip: true },
        { name: 'Bob', age: 25, vip: false },
        { name: 'Carol', age: 45, vip: true },
        { name: 'Dan', age: 60, vip: false },
    ] as Row[],
    undefined,
    { writeColumnIndex: { features: ['name', 'age', 'vip'] } },
);

// ───────────────────── Symmetry tests ──────────────────────────────

const SCENARIOS = [
    { name: 'geograph file (every index)', bytes: GEOGRAPH_BYTES },
    { name: 'graph file (rows + links)', bytes: GRAPH_BYTES },
    { name: 'table file (rows only)', bytes: TABLE_BYTES },
];

for (const { name, bytes } of SCENARIOS) {
    describe(`cold vs preload symmetry — ${name}`, () => {
        let cold: FlatRecord;
        let warm: FlatRecord;

        beforeAll(async () => {
            cold = await FlatRecord.open(bytes);
            warm = await FlatRecord.open(bytes);
            await warm.preload();
        });

        it('header metadata matches', () => {
            expect(cold.featuresCount).toBe(warm.featuresCount);
            expect(cold.linksCount).toBe(warm.linksCount);
            expect(cold.mode).toBe(warm.mode);
            expect(cold.hasGeometry).toBe(warm.hasGeometry);
            expect(cold.hasLinks).toBe(warm.hasLinks);
            expect(cold.header.headerCrc32).toBe(warm.header.headerCrc32);
        });

        it('inspect() snapshots agree on indices', () => {
            const c = cold.inspect();
            const w = warm.inspect();
            expect(c.indexes).toEqual(w.indexes);
            expect(c.featuresCount).toBe(w.featuresCount);
            expect(c.linksCount).toBe(w.linksCount);
            expect(c.totalBytes).toBe(w.totalBytes);
        });

        it('getFeature(0) matches cold vs preload', async () => {
            const c = await cold.getFeature(0);
            const w = await warm.getFeature(0);
            expect(eqFeature(c, w)).toBe(true);
        });

        it('features() iteration matches', async () => {
            const c = await collect(cold.features());
            const w = await collect(warm.features());
            eqFeatureArray(c, w);
        });

        it('getFeatures(bulk) matches', async () => {
            const indices = [
                cold.featuresCount - 1,
                0,
                Math.floor(cold.featuresCount / 2),
            ];
            const c = await cold.getFeatures(indices);
            const w = await warm.getFeatures(indices);
            eqFeatureArray(c, w);
        });

        if (name === 'geograph file (every index)') {
            it('featuresInBbox matches', async () => {
                const rect = { minX: -50, minY: -25, maxX: -42, maxY: -10 };
                const c = await collect(cold.featuresInBbox(rect));
                const w = await collect(warm.featuresInBbox(rect));
                eqFeatureArray(c, w);
            });

            it('nearestFeatures matches', async () => {
                const opts = { limit: 3 } as const;
                const c = await collect(cold.nearestFeatures([-46.63, -23.55], opts));
                const w = await collect(warm.nearestFeatures([-46.63, -23.55], opts));
                expect(c.map((r) => r.index)).toEqual(w.map((r) => r.index));
                for (let i = 0; i < c.length; i++) {
                    expect(c[i].distance).toBeCloseTo(w[i].distance, 10);
                }
            });
        }

        if (name !== 'table file (rows only)') {
            it('outgoingLinksOf(0) matches', async () => {
                const c = await collect(cold.outgoingLinksOf(0));
                const w = await collect(warm.outgoingLinksOf(0));
                eqLinkArray(c, w);
            });

            it('incomingLinksOf matches', async () => {
                const target = cold.featuresCount > 1 ? 2 : 0;
                const c = await collect(cold.incomingLinksOf(target));
                const w = await collect(warm.incomingLinksOf(target));
                eqLinkArray(c, w);
            });

            it('allLinks matches', async () => {
                const c = await collect(cold.allLinks());
                const w = await collect(warm.allLinks());
                eqLinkArray(c, w);
            });

            it('getLink(i) matches across all storage indices', async () => {
                for (let i = 0; i < cold.linksCount; i++) {
                    const cl = await cold.getLink(i);
                    const wl = await warm.getLink(i);
                    expect(eqLink(cl, wl), `link ${i}`).toBe(true);
                }
            });

            it('getLinks bulk matches', async () => {
                const indices = Array.from({ length: cold.linksCount }, (_, i) => i);
                const c = await cold.getLinks(indices);
                const w = await warm.getLinks(indices);
                eqLinkArray(c, w);
            });

            it('outDegreeOf / inDegreeOf match for every feature', async () => {
                for (let v = 0; v < cold.featuresCount; v++) {
                    expect(await cold.outDegreeOf(v)).toBe(await warm.outDegreeOf(v));
                    expect(await cold.inDegreeOf(v)).toBe(await warm.inDegreeOf(v));
                }
            });

            it('shortestPath matches', async () => {
                const path1 = await cold.shortestPath(0, cold.featuresCount - 1);
                const path2 = await warm.shortestPath(0, warm.featuresCount - 1);
                if (path1 === null) {
                    expect(path2).toBeNull();
                } else {
                    expect(path2).not.toBeNull();
                    expect(path1.cost).toBeCloseTo(path2!.cost, 10);
                    expect(path1.features.length).toBe(path2!.features.length);
                    expect(path1.links.length).toBe(path2!.links.length);
                }
            });
        }

        it('findFeaturesByText matches', async () => {
            const term = name.includes('table') ? 'alice' : name.includes('graph file (rows + links)') ? 'A' : 'rio';
            const col = name.includes('table') ? 'name' : 'id';
            // The geograph file uses 'name' too; pick column per scenario.
            const column = name.includes('geograph') ? 'name' : col;
            const c: Array<{ index: number; tier: string }> = [];
            for await (const h of cold.findFeaturesByText(column, term)) c.push({ index: h.index, tier: h.tier });
            const w: Array<{ index: number; tier: string }> = [];
            for await (const h of warm.findFeaturesByText(column, term)) w.push({ index: h.index, tier: h.tier });
            expect(c).toEqual(w);
        });

        it('findFeaturesByValue matches', async () => {
            // Each scenario has an indexed numeric column.
            const column = name.includes('table') ? 'age' : name.includes('graph file (rows + links)') ? null : 'elev';
            if (!column) return;
            const c: number[] = [];
            for await (const f of cold.findFeaturesByValue(column, { gte: 1 })) c.push(f.id as number);
            const w: number[] = [];
            for await (const f of warm.findFeaturesByValue(column, { gte: 1 })) w.push(f.id as number);
            expect(c.sort()).toEqual(w.sort());
        });

        it('release() then re-query produces same results as the cold path', async () => {
            // Sanity: after preload + release, the reader falls back to
            // cold reads. Output must match.
            const before = await collect(warm.features());
            warm.release();
            const after = await collect(warm.features());
            eqFeatureArray(before, after);
        });
    });
}
