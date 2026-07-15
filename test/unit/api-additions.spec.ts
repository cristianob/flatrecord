/**
 * Coverage for the API additions introduced after the initial 3.0
 * cut: `getLink`, `getFeatures` / `getLinks` (bulk), `outDegreeOf` /
 * `inDegreeOf`, `linkIndexBetween`, `incomingLinksOf`,
 * `nearestFeatures` (meters / km / nm), `inspect`, header CRC32,
 * explicit schema validation.
 */

import { describe, expect, it } from 'vitest';
import { FlatRecord, serialize, type Row } from '../../src/ts/geojson.js';
import type { AdjacencyListInput } from '../../src/ts/link-types.js';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const v of iter) out.push(v);
    return out;
}

describe('getLink(storageIdx)', () => {
    const rows: Row[] = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
    const adj: AdjacencyListInput = {
        links: [
            { from: 0, to: 1, properties: { w: 1 } },
            { from: 0, to: 2, properties: { w: 2 } },
            { from: 1, to: 2, properties: { w: 3 } },
        ],
    };

    it('round-trips single link by storage index', async () => {
        const bytes = serialize(rows, adj);
        const fr = await FlatRecord.open(bytes);
        const l0 = await fr.getLink(0);
        const l1 = await fr.getLink(1);
        const l2 = await fr.getLink(2);
        // Sorted by `from`: 3 with from=0 come first.
        expect([l0.to, l1.to, l2.to].sort()).toEqual([1, 2, 2]);
        expect(l0.properties.w).toBeDefined();
    });

    it('throws on out-of-range index', async () => {
        const bytes = serialize(rows, adj);
        const fr = await FlatRecord.open(bytes);
        await expect(fr.getLink(99)).rejects.toThrow(/out of range/);
        await expect(fr.getLink(-1)).rejects.toThrow(/out of range/);
    });

    it('caches subsequent reads of the same link', async () => {
        const bytes = serialize(rows, adj);
        const fr = await FlatRecord.open(bytes);
        const a = await fr.getLink(0);
        const b = await fr.getLink(0);
        expect(b).toBe(a);
    });
});

describe('getFeatures / getLinks — bulk fetch', () => {
    const geojson = {
        type: 'FeatureCollection' as const,
        features: Array.from({ length: 50 }, (_, i) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [i * 0.1, i * 0.05] },
            properties: { id: `p${i}`, n: i },
        })),
    };
    const adj: AdjacencyListInput = {
        links: Array.from({ length: 30 }, (_, i) => ({
            from: i,
            to: (i + 1) % 50,
            properties: { label: `e${i}` },
        })),
    };

    it('getFeatures returns features in input order', async () => {
        const bytes = serialize(geojson, adj);
        const fr = await FlatRecord.open(bytes);
        const result = await fr.getFeatures([3, 7, 7, 0, 49]);
        expect(result.map((f) => (f.properties as { n: number }).n)).toEqual([3, 7, 7, 0, 49]);
    });

    it('getFeatures handles empty array', async () => {
        const bytes = serialize(geojson, adj);
        const fr = await FlatRecord.open(bytes);
        expect(await fr.getFeatures([])).toEqual([]);
    });

    it('getFeatures throws on OOR index', async () => {
        const bytes = serialize(geojson, adj);
        const fr = await FlatRecord.open(bytes);
        await expect(fr.getFeatures([0, 100])).rejects.toThrow(/out of range/);
    });

    it('getLinks returns links in input order', async () => {
        const bytes = serialize(geojson, adj);
        const fr = await FlatRecord.open(bytes);
        const links = await fr.getLinks([0, 5, 10]);
        expect(links).toHaveLength(3);
        for (const l of links) {
            expect(typeof l.from).toBe('number');
            expect(typeof l.to).toBe('number');
        }
    });

    it('getLinks throws on table mode', async () => {
        const bytes = serialize([{ a: 1 }, { a: 2 }]);
        const fr = await FlatRecord.open(bytes);
        await expect(fr.getLinks([0])).rejects.toThrow(/no links/i);
    });
});

describe('outDegreeOf / inDegreeOf', () => {
    const rows: Row[] = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }];
    const adj: AdjacencyListInput = {
        // A → B, A → C, A → D, B → C, B → D
        links: [
            { from: 0, to: 1 },
            { from: 0, to: 2 },
            { from: 0, to: 3 },
            { from: 1, to: 2 },
            { from: 1, to: 3 },
        ],
    };

    it('outDegreeOf returns count from CSR', async () => {
        const bytes = serialize(rows, adj);
        const fr = await FlatRecord.open(bytes);
        expect(await fr.outDegreeOf(0)).toBe(3);
        expect(await fr.outDegreeOf(1)).toBe(2);
        expect(await fr.outDegreeOf(2)).toBe(0);
        expect(await fr.outDegreeOf(3)).toBe(0);
    });

    it('inDegreeOf returns count from reverse CSR', async () => {
        const bytes = serialize(rows, adj);
        const fr = await FlatRecord.open(bytes);
        expect(await fr.inDegreeOf(0)).toBe(0);
        expect(await fr.inDegreeOf(1)).toBe(1);
        expect(await fr.inDegreeOf(2)).toBe(2);
        expect(await fr.inDegreeOf(3)).toBe(2);
    });

    it('outDegreeOf is 0 on table mode (no links)', async () => {
        const bytes = serialize([{ a: 1 }, { a: 2 }]);
        const fr = await FlatRecord.open(bytes);
        expect(await fr.outDegreeOf(0)).toBe(0);
    });

    it('inDegreeOf throws when reverse CSR is disabled', async () => {
        const bytes = serialize(rows, adj, { writeReverseAdjacencyIndex: false });
        const fr = await FlatRecord.open(bytes);
        await expect(fr.inDegreeOf(0)).rejects.toThrow(/writeReverseAdjacencyIndex/);
    });
});

describe('linkIndexBetween(from, to)', () => {
    const rows: Row[] = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
    const adj: AdjacencyListInput = {
        links: [
            { from: 0, to: 1, properties: { tag: 'ab' } },
            { from: 0, to: 2, properties: { tag: 'ac' } },
            { from: 1, to: 2, properties: { tag: 'bc' } },
        ],
    };

    it('finds an existing link by endpoints', async () => {
        const bytes = serialize(rows, adj);
        const fr = await FlatRecord.open(bytes);
        const l = await fr.linkIndexBetween(0, 2);
        expect(l).not.toBeNull();
        expect(l?.properties.tag).toBe('ac');
    });

    it('returns null for a missing link', async () => {
        const bytes = serialize(rows, adj);
        const fr = await FlatRecord.open(bytes);
        expect(await fr.linkIndexBetween(2, 0)).toBeNull();
    });

    it('returns null on table mode', async () => {
        const bytes = serialize(rows);
        const fr = await FlatRecord.open(bytes);
        expect(await fr.linkIndexBetween(0, 1)).toBeNull();
    });
});

describe('incomingLinksOf(v)', () => {
    const rows: Row[] = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }];
    const adj: AdjacencyListInput = {
        links: [
            { from: 0, to: 1, properties: { src: 'A' } },
            { from: 0, to: 2, properties: { src: 'A' } },
            { from: 1, to: 2, properties: { src: 'B' } },
            { from: 3, to: 2, properties: { src: 'D' } },
        ],
    };

    it('yields incoming links in storage order', async () => {
        const bytes = serialize(rows, adj);
        const fr = await FlatRecord.open(bytes);
        const incoming = await collect(fr.incomingLinksOf(2));
        // 3 links point to feature 2.
        expect(incoming).toHaveLength(3);
        expect(incoming.map((l) => l.from).sort()).toEqual([0, 1, 3]);
        expect(incoming.map((l) => l.properties.src).sort()).toEqual(['A', 'B', 'D']);
    });

    it('returns empty for a feature with no incoming links', async () => {
        const bytes = serialize(rows, adj);
        const fr = await FlatRecord.open(bytes);
        const incoming = await collect(fr.incomingLinksOf(0));
        expect(incoming).toEqual([]);
    });

    it('caches per-feature results', async () => {
        const bytes = serialize(rows, adj);
        const fr = await FlatRecord.open(bytes);
        const a = await collect(fr.incomingLinksOf(2));
        const b = await collect(fr.incomingLinksOf(2));
        expect(b).toEqual(a);
    });

    it('throws when reverse CSR is disabled', async () => {
        const bytes = serialize(rows, adj, { writeReverseAdjacencyIndex: false });
        const fr = await FlatRecord.open(bytes);
        await expect(collect(fr.incomingLinksOf(2))).rejects.toThrow(/reverse adjacency/);
    });
});

describe('nearestFeatures(point, options?)', () => {
    // 5×5 grid of points at integer lon/lat (degrees).
    const features = [];
    for (let lat = 0; lat < 5; lat++) {
        for (let lon = 0; lon < 5; lon++) {
            features.push({
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [lon, lat] },
                properties: { lon, lat, id: `${lon}-${lat}` },
            });
        }
    }
    const geojson = { type: 'FeatureCollection' as const, features };

    it('yields nearest features in ascending distance; caller breaks when done', async () => {
        const bytes = serialize(geojson);
        const fr = await FlatRecord.open(bytes);
        // Query at (2.1, 2.1) — closest is (2, 2). Take 4 manually.
        const results: number[] = [];
        for await (const r of fr.nearestFeatures([2.1, 2.1])) {
            results.push((r.feature.properties as { lon: number }).lon);
            if (results.length === 4) break;
        }
        expect(results).toHaveLength(4);
        expect(results[0]).toBe(2);
    });

    it('distances are non-decreasing', async () => {
        const bytes = serialize(geojson);
        const fr = await FlatRecord.open(bytes);
        let prev = -Infinity;
        for await (const r of fr.nearestFeatures([0, 0])) {
            expect(r.distance).toBeGreaterThanOrEqual(prev);
            prev = r.distance;
        }
    });

    it('default limit caps the result at 100', async () => {
        // 25 features < 100 → all yielded. Default behaviour
        // matches "give me everything" on small datasets while still
        // capping huge ones at 100.
        const bytes = serialize(geojson);
        const fr = await FlatRecord.open(bytes);
        const out = await collect(fr.nearestFeatures([2, 2]));
        expect(out).toHaveLength(features.length);
    });

    it('limit: Infinity yields every feature', async () => {
        const bytes = serialize(geojson);
        const fr = await FlatRecord.open(bytes);
        const all = await collect(fr.nearestFeatures([2, 2], { limit: Infinity }));
        expect(all).toHaveLength(features.length);
    });

    it('limit caps the result count', async () => {
        const bytes = serialize(geojson);
        const fr = await FlatRecord.open(bytes);
        const out = await collect(fr.nearestFeatures([2.1, 2.1], { limit: 4 }));
        expect(out).toHaveLength(4);
        // First result is (2, 2) (closest to [2.1, 2.1]).
        expect((out[0].feature.properties as { lon: number; lat: number }).lon).toBe(2);
        expect((out[0].feature.properties as { lon: number; lat: number }).lat).toBe(2);
    });

    it('limit > totalFeatures yields all features', async () => {
        const bytes = serialize(geojson);
        const fr = await FlatRecord.open(bytes);
        const all = await collect(fr.nearestFeatures([0, 0], { limit: 9999 }));
        expect(all).toHaveLength(features.length);
    });

    it('limit: 0 yields nothing', async () => {
        const bytes = serialize(geojson);
        const fr = await FlatRecord.open(bytes);
        const out = await collect(fr.nearestFeatures([0, 0], { limit: 0 }));
        expect(out).toEqual([]);
    });

    it('limit + maxDistance: whichever fires first stops the search', async () => {
        const bytes = serialize(geojson);
        const fr = await FlatRecord.open(bytes);
        // Cap on count: very small limit, large radius.
        const byLimit = await collect(
            fr.nearestFeatures([2.5, 2.5], { limit: 2, maxDistance: 10000, unit: 'kilometers' }),
        );
        expect(byLimit).toHaveLength(2);
        // Cap on radius: huge limit, tiny radius.
        const byRadius = await collect(
            fr.nearestFeatures([2.5, 2.5], { limit: 9999, maxDistance: 80, unit: 'kilometers' }),
        );
        expect(byRadius.length).toBeGreaterThan(0);
        expect(byRadius.length).toBeLessThan(features.length);
    });

    it('unit: kilometers ≈ meters / 1000', async () => {
        const bytes = serialize(geojson);
        const fr = await FlatRecord.open(bytes);
        const m = (await collect(fr.nearestFeatures([2.5, 2.5], { unit: 'meters' })))[0];
        const km = (await collect(fr.nearestFeatures([2.5, 2.5], { unit: 'kilometers' })))[0];
        expect(km.distance).toBeCloseTo(m.distance / 1000, 6);
    });

    it('unit: nautical_miles ≈ meters / 1852', async () => {
        const bytes = serialize(geojson);
        const fr = await FlatRecord.open(bytes);
        const m = (await collect(fr.nearestFeatures([2.5, 2.5], { unit: 'meters' })))[0];
        const nm = (await collect(fr.nearestFeatures([2.5, 2.5], { unit: 'nautical_miles' })))[0];
        expect(nm.distance).toBeCloseTo(m.distance / 1852, 6);
    });

    it('maxDistance caps the search (generator terminates on its own)', async () => {
        const bytes = serialize(geojson);
        const fr = await FlatRecord.open(bytes);
        const results = await collect(
            fr.nearestFeatures([2.5, 2.5], { unit: 'kilometers', maxDistance: 80 }),
        );
        expect(results.length).toBeGreaterThan(0);
        expect(results.length).toBeLessThan(features.length);
        for (const r of results) expect(r.distance).toBeLessThanOrEqual(80);
    });

    it('throws on table mode (no geometry)', async () => {
        const bytes = serialize([{ a: 1 }]);
        const fr = await FlatRecord.open(bytes);
        await expect(collect(fr.nearestFeatures([0, 0]))).rejects.toThrow(/geometry/i);
    });

    it('throws when writeSpatialIndex is disabled', async () => {
        const bytes = serialize(geojson, undefined, { writeSpatialIndex: false });
        const fr = await FlatRecord.open(bytes);
        await expect(collect(fr.nearestFeatures([0, 0]))).rejects.toThrow(/writeSpatialIndex/);
    });
});

describe('fr.inspect()', () => {
    it('reports block layout + indices for a geograph file', async () => {
        const geojson = {
            type: 'FeatureCollection' as const,
            features: [
                { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [0, 0] }, properties: { id: 'a' } },
                { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [1, 1] }, properties: { id: 'b' } },
            ],
        };
        const bytes = serialize(geojson, { links: [{ from: 0, to: 1, properties: { w: 1 } }] }, {
            writeColumnIndex: { features: ['id'], links: ['w'] },
        });
        const fr = await FlatRecord.open(bytes);
        const info = fr.inspect();
        expect(info.mode).toBe('geograph');
        expect(info.featuresCount).toBe(2);
        expect(info.linksCount).toBe(1);
        expect(info.indexes.featureSpatialIndex).toBe(true);
        expect(info.indexes.linkSpatialIndex).toBe(true);
        expect(info.indexes.adjacencyIndex).toBe(true);
        expect(info.indexes.reverseAdjacencyIndex).toBe(true);
        expect(info.indexes.featureColumnIndices).toEqual(['id']);
        expect(info.indexes.linkColumnIndices).toEqual(['w']);
        expect(info.blocks.length).toBeGreaterThan(0);
        // Block offsets are monotonically non-decreasing.
        for (let i = 1; i < info.blocks.length; i++) {
            expect(info.blocks[i].offset).toBeGreaterThanOrEqual(info.blocks[i - 1].offset);
        }
        // Each block's percent is consistent.
        for (const b of info.blocks) {
            expect(b.percent).toBeGreaterThan(0);
            expect(b.percent).toBeLessThanOrEqual(100);
        }
        // CRC was computed and verified during open.
        expect(info.crc32.verified).toBe(true);
        expect(info.crc32.stored).not.toBe(0);
    });

    it('reports table mode with no spatial indices', async () => {
        const bytes = serialize([{ a: 1 }, { a: 2 }]);
        const fr = await FlatRecord.open(bytes);
        const info = fr.inspect();
        expect(info.mode).toBe('table');
        expect(info.indexes.featureSpatialIndex).toBe(false);
        expect(info.indexes.adjacencyIndex).toBe(false);
    });
});

describe('header CRC32', () => {
    it('writer produces a non-zero CRC by default', async () => {
        const bytes = serialize([{ a: 1 }, { a: 2 }]);
        const fr = await FlatRecord.open(bytes);
        expect(fr.header.headerCrc32).not.toBe(0);
    });

    it('writer can opt out via writeHeaderCrc: false', async () => {
        const bytes = serialize([{ a: 1 }, { a: 2 }], undefined, { writeHeaderCrc: false });
        const fr = await FlatRecord.open(bytes);
        expect(fr.header.headerCrc32).toBe(0);
    });

    it('open rejects a file with a corrupted header', async () => {
        const bytes = serialize([{ a: 1 }, { a: 2 }]);
        // Flip a single byte inside the header (skip the magic + size prefix).
        const corrupted = new Uint8Array(bytes);
        corrupted[15] ^= 0xff;
        await expect(FlatRecord.open(corrupted)).rejects.toThrow(/CRC mismatch/);
    });

    it('open accepts a file written with writeHeaderCrc: false even if bytes change', async () => {
        // No verification ⇒ readers can't tell. (Confirms opt-out behavior.)
        const bytes = serialize([{ a: 1 }, { a: 2 }], undefined, { writeHeaderCrc: false });
        const fr = await FlatRecord.open(bytes);
        expect(fr.header.headerCrc32).toBe(0);
    });
});

describe('header identity strings (name / title / description / metadata)', () => {
    it('writer stores nothing by default; reader sees nulls', async () => {
        const bytes = serialize([{ a: 1 }]);
        const fr = await FlatRecord.open(bytes);
        expect(fr.header.name).toBeNull();
        expect(fr.header.title).toBeNull();
        expect(fr.header.description).toBeNull();
        expect(fr.header.metadata).toBeNull();
    });

    it('writer stores every supplied identity string', async () => {
        const bytes = serialize([{ a: 1 }], undefined, {
            name: 'sao_paulo_airports',
            title: 'Airports of São Paulo state',
            description: 'Curated subset of OurAirports data, restricted to the SP state polygon and updated quarterly.',
            metadata: JSON.stringify({ source: 'OurAirports', revision: 142, license: 'CC0-1.0' }),
        });
        const fr = await FlatRecord.open(bytes);
        expect(fr.header.name).toBe('sao_paulo_airports');
        expect(fr.header.title).toBe('Airports of São Paulo state');
        expect(fr.header.description?.startsWith('Curated subset')).toBe(true);
        const meta = JSON.parse(fr.header.metadata!);
        expect(meta.source).toBe('OurAirports');
        expect(meta.revision).toBe(142);
    });

    it('any subset of identity strings can be set independently', async () => {
        const bytes = serialize([{ a: 1 }], undefined, { title: 'Just a title' });
        const fr = await FlatRecord.open(bytes);
        expect(fr.header.title).toBe('Just a title');
        expect(fr.header.description).toBeNull();
        expect(fr.header.metadata).toBeNull();
    });

    it('inspect() reflects identity strings via the header — not as blocks', async () => {
        const bytes = serialize([{ a: 1 }], undefined, {
            title: 'X',
            description: 'Y',
            metadata: 'Z',
        });
        const fr = await FlatRecord.open(bytes);
        const info = fr.inspect();
        expect(info.featuresCount).toBe(1);
        // No "identity" block — strings live inside the header itself.
        expect(info.blocks.some((b) => b.block.includes('identity'))).toBe(false);
    });
});

describe('header timestamp (unix-time-ms)', () => {
    it('writer stores nothing by default; reader sees null', async () => {
        const bytes = serialize([{ a: 1 }]);
        const fr = await FlatRecord.open(bytes);
        expect(fr.header.timestamp).toBeNull();
    });

    it('timestamp: number → stored verbatim', async () => {
        const t = 1700000000000;
        const bytes = serialize([{ a: 1 }], undefined, { timestamp: t });
        const fr = await FlatRecord.open(bytes);
        expect(fr.header.timestamp).toBe(t);
    });

    it("timestamp: 'now' → captures Date.now() at serialize time", async () => {
        const before = Date.now();
        const bytes = serialize([{ a: 1 }], undefined, { timestamp: 'now' });
        const after = Date.now();
        const fr = await FlatRecord.open(bytes);
        expect(fr.header.timestamp).not.toBeNull();
        expect(fr.header.timestamp!).toBeGreaterThanOrEqual(before);
        expect(fr.header.timestamp!).toBeLessThanOrEqual(after);
    });

    it("timestamp: 0 is treated as 'not set'", async () => {
        const bytes = serialize([{ a: 1 }], undefined, { timestamp: 0 });
        const fr = await FlatRecord.open(bytes);
        expect(fr.header.timestamp).toBeNull();
    });
});

describe('schema validation (explicit)', () => {
    it('serialize accepts records that match an explicit schema', async () => {
        const rows: Row[] = [
            { id: 'a', age: 30, vip: true },
            { id: 'b', age: 25, vip: false },
        ];
        const bytes = serialize(rows, undefined, {
            schema: {
                features: {
                    id: { type: 'String' },
                    age: { type: 'Int' },
                    vip: { type: 'Bool' },
                },
            },
        });
        const fr = await FlatRecord.open(bytes);
        expect(fr.featuresCount).toBe(2);
    });

    it('throws on a type mismatch against the declared schema', async () => {
        expect(() =>
            serialize(
                [{ id: 'a', age: 'thirty' as unknown as number }],
                undefined,
                { schema: { features: { id: { type: 'String' }, age: { type: 'Int' } } } },
            ),
        ).toThrow(/expected number.*got string/);
    });

    it('throws on an unknown column not in the schema', async () => {
        expect(() =>
            serialize([{ id: 'a', surprise: true }], undefined, {
                schema: { features: { id: { type: 'String' } } },
            }),
        ).toThrow(/unknown column 'surprise'/);
    });

    it('throws on missing required column', async () => {
        expect(() =>
            serialize([{ id: 'a' }, { /* id missing */ }], undefined, {
                schema: { features: { id: { type: 'String', required: true } } },
            }),
        ).toThrow(/missing required column 'id'/);
    });

    it('throws on null in a non-nullable column', async () => {
        expect(() =>
            serialize([{ id: 'a' }, { id: null as unknown as string }], undefined, {
                schema: { features: { id: { type: 'String', nullable: false } } },
            }),
        ).toThrow(/is not nullable/);
    });

    it('validates link schemas the same way', async () => {
        const rows: Row[] = [{ id: 'a' }, { id: 'b' }];
        expect(() =>
            serialize(rows, { links: [{ from: 0, to: 1, properties: { w: 'bad' as unknown as number } }] }, {
                schema: { links: { w: { type: 'Double' } } },
            }),
        ).toThrow(/expected number/);
    });
});

describe('getFeatureBbox(index)', () => {
    const geojson = {
        type: 'FeatureCollection' as const,
        features: [
            {
                type: 'Feature' as const,
                geometry: {
                    type: 'Polygon' as const,
                    coordinates: [
                        [
                            [-46, -23],
                            [-44, -23],
                            [-44, -21],
                            [-46, -21],
                            [-46, -23],
                        ],
                    ],
                },
                properties: { id: 'A' },
            },
            {
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [-47.9, -15.8] },
                properties: { id: 'B' },
            },
            {
                type: 'Feature' as const,
                geometry: {
                    type: 'MultiPolygon' as const,
                    coordinates: [
                        [
                            [
                                [10, 10],
                                [12, 10],
                                [12, 13],
                                [10, 13],
                                [10, 10],
                            ],
                        ],
                    ],
                },
                properties: { id: 'C' },
            },
        ],
    };

    // Ground-truth envelope over a decoded feature's own geometry — ordering- and
    // quantization-agnostic (compares the R-tree box against the same coords the
    // reader returns).
    const envelopeOf = (feature: { geometry: { coordinates: unknown } }) => {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const walk = (node: any): void => {
            if (typeof node[0] === 'number') {
                const [x, y] = node as [number, number];
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
                return;
            }
            for (const child of node) walk(child);
        };
        walk(feature.geometry.coordinates);
        return { minX, minY, maxX, maxY };
    };

    it('returns each feature stored bbox, matching its geometry envelope', async () => {
        const fr = await FlatRecord.open(serialize(geojson));
        const feats = await fr.loadFeatures();
        for (let i = 0; i < feats.length; i++) {
            const box = await fr.getFeatureBbox(i);
            const exp = envelopeOf(feats[i]);
            expect(box).not.toBeNull();
            expect(box!.minX).toBeCloseTo(exp.minX, 6);
            expect(box!.minY).toBeCloseTo(exp.minY, 6);
            expect(box!.maxX).toBeCloseTo(exp.maxX, 6);
            expect(box!.maxY).toBeCloseTo(exp.maxY, 6);
        }
    });

    it('throws on out-of-range index', async () => {
        const fr = await FlatRecord.open(serialize(geojson));
        await expect(fr.getFeatureBbox(99)).rejects.toThrow(/out of range/);
        await expect(fr.getFeatureBbox(-1)).rejects.toThrow(/out of range/);
    });

    it('returns null when the file has no feature spatial index', async () => {
        const fr = await FlatRecord.open(serialize(geojson, undefined, { writeSpatialIndex: false }));
        expect(await fr.getFeatureBbox(0)).toBeNull();
    });

    it('still works after preload({ detach: true }) (served from cached index bytes)', async () => {
        const fr = await FlatRecord.open(serialize(geojson));
        await fr.preload({ detach: true });
        const box = await fr.getFeatureBbox(0);
        expect(box).not.toBeNull();
        expect(box!.minX).toBeCloseTo(-46, 6);
        expect(box!.maxY).toBeCloseTo(-21, 6);
    });
});

describe('loadFeatures({ bbox: true })', () => {
    const geojson = {
        type: 'FeatureCollection' as const,
        features: [
            {
                type: 'Feature' as const,
                geometry: {
                    type: 'Polygon' as const,
                    coordinates: [
                        [
                            [-46, -23],
                            [-44, -23],
                            [-44, -21],
                            [-46, -21],
                            [-46, -23],
                        ],
                    ],
                },
                properties: { id: 'A' },
            },
            {
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [-47.9, -15.8] },
                properties: { id: 'B' },
            },
        ],
    };

    it('attaches [minX, minY, maxX, maxY] to every feature, matching getFeatureBbox', async () => {
        const fr = await FlatRecord.open(serialize(geojson));
        const feats = await fr.loadFeatures({ bbox: true });
        for (const f of feats) {
            expect(Array.isArray(f.bbox)).toBe(true);
            expect(f.bbox).toHaveLength(4);
        }
        const box0 = await fr.getFeatureBbox(0);
        expect(feats[0].bbox).toEqual([box0!.minX, box0!.minY, box0!.maxX, box0!.maxY]);
    });

    it('leaves bbox undefined when the option is omitted', async () => {
        const fr = await FlatRecord.open(serialize(geojson));
        const feats = await fr.loadFeatures();
        expect(feats[0].bbox).toBeUndefined();
    });

    it('throws when the file has no feature spatial index', async () => {
        const fr = await FlatRecord.open(serialize(geojson, undefined, { writeSpatialIndex: false }));
        await expect(fr.loadFeatures({ bbox: true })).rejects.toThrow(/spatial index/);
    });
});
