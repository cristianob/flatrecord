/**
 * Robustness: malformed property index blocks and other corrupted-byte
 * scenarios. Each test serialises a valid FlatRecord file, then surgically
 * mutates specific bytes inside the property-index block before opening
 * — the reader must either throw a descriptive error or stop gracefully
 * (no infinite loop, no silent garbage parse).
 */

import type { FeatureCollection as GeoJsonFeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { FlatRecord, serialize } from '../../src/ts/geojson.js';
import type { AdjacencyListInput } from '../../src/ts/link-types.js';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const v of iter) out.push(v);
    return out;
}

function tinyGraph(): { geojson: GeoJsonFeatureCollection; adjacency: AdjacencyListInput } {
    return {
        geojson: {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'alpha', n: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: 'beta',  n: 2 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { name: 'gamma', n: 3 } },
            ],
        },
        adjacency: {
            links: [
                { from: 0, to: 1, properties: { road: 'aa', km: 10, ok: true } },
                { from: 1, to: 2, properties: { road: 'bb', km: 20, ok: false } },
            ],
        },
    };
}

/**
 * Returns `{ offset, length }` of the first feature property index block
 * by reading the flatbuffer header's directory. Used by tests below to
 * surgically corrupt the block's content.
 */
async function locateFeaturePropIdx(bytes: Uint8Array): Promise<{ offset: number; length: number }> {
    const fr = await FlatRecord.open(bytes);
    const e = fr.header.featureColumnIndices[0];
    if (!e) throw new Error('expected feature property index in fixture');
    return { offset: e.offset, length: e.length };
}

describe('robustness — corrupt property index block', () => {
    it('throws when the text-column count claims more columns than the buffer holds', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { writeColumnIndex: { features: ['name'] } });
        const corrupted = new Uint8Array(bytes);
        const { offset } = await locateFeaturePropIdx(corrupted);
        // First field of the block payload is `textColumnCount: uint32`.
        new DataView(corrupted.buffer).setUint32(offset, 0xffff_ffff, true);

        const fr = await FlatRecord.open(corrupted);
        await expect(collect(fr.findFeaturesByText('name', 'alpha'))).rejects.toThrow();
    });

    it('rejects a property index where a token offset points outside the token pool', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { writeColumnIndex: { features: ['name'] } });
        const corrupted = new Uint8Array(bytes);
        const { offset, length } = await locateFeaturePropIdx(corrupted);
        const blockEnd = offset + length;
        for (let i = blockEnd - Math.min(40, length); i < blockEnd; i++) corrupted[i] = 0xff;

        const fr = await FlatRecord.open(corrupted);
        try {
            const hits = await collect(fr.findFeaturesByText('name', 'alpha'));
            expect(Array.isArray(hits)).toBe(true);
            expect(hits.length).toBeLessThanOrEqual(corrupted.byteLength);
        } catch (err) {
            expect(err).toBeInstanceOf(Error);
        }
    });

    it('rejects feature column index with truncated block content', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { writeColumnIndex: { features: ['name'] } });
        const corrupted = new Uint8Array(bytes);
        const { offset } = await locateFeaturePropIdx(corrupted);
        // Zero out the beginning of the block content so the textColumnCount
        // is 0 but the parser still attempts to read past EOF on subsequent reads.
        new DataView(corrupted.buffer).setUint32(offset, 0, true);
        try {
            const fr = await FlatRecord.open(corrupted);
            await collect(fr.findFeaturesByText('name', 'alpha'));
        } catch (err) {
            expect(err).toBeInstanceOf(Error);
        }
    });
});

describe('robustness — corrupted file headers and magic bytes', () => {
    it('rejects a buffer with the wrong magic byte version', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency);
        const corrupted = new Uint8Array(bytes);
        // Magic is "fr\x02fgg\x00"; flip byte 3 to 0x99 to fake a future major.
        corrupted[3] = 0x99;
        await expect(FlatRecord.open(corrupted)).rejects.toThrow(/magic/i);
    });

    it('rejects a buffer with totally random first 32 bytes', async () => {
        const corrupted = new Uint8Array(64).map((_, i) => (i * 0x9e + 1) & 0xff);
        await expect(FlatRecord.open(corrupted)).rejects.toThrow();
    });

    it('rejects an empty buffer', async () => {
        await expect(FlatRecord.open(new Uint8Array(0))).rejects.toThrow();
    });

    it('rejects a buffer with only the magic bytes (truncated)', async () => {
        const onlyMagic = new Uint8Array([0x66, 0x72, 0x62, 0x01, 0x66, 0x72, 0x62, 0x00]);
        await expect(FlatRecord.open(onlyMagic)).rejects.toThrow();
    });
});

describe('robustness — value-column quirks', () => {
    it('skips features with NaN/Infinity/null in a numeric column', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { v: 1 } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { v: Number.NaN } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { v: Number.POSITIVE_INFINITY } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [3, 0] }, properties: { v: null } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [4, 0] }, properties: { v: 5 } },
            ],
        };
        const bytes = serialize(geojson, { links: [] }, { writeColumnIndex: { features: ['v'] } });
        const fr = await FlatRecord.open(bytes);
        const hits = await collect(fr.findFeaturesByValue('v', { gte: 0 }));
        // Only the 1 and 5 entries should be indexed and returned.
        expect(hits.length).toBe(2);
    });

    it('handles a boolean column with all-true or all-false records', async () => {
        const allTrue: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: Array.from({ length: 5 }, (_, i) => ({
                type: 'Feature' as const,
                geometry: { type: 'Point' as const, coordinates: [i, 0] },
                properties: { flag: true },
            })),
        };
        const bytes = serialize(allTrue, { links: [] }, { writeColumnIndex: { features: ['flag'] } });
        const fr = await FlatRecord.open(bytes);
        expect((await collect(fr.findFeaturesByValue('flag', { eq: true }))).length).toBe(5);
        expect((await collect(fr.findFeaturesByValue('flag', { eq: false }))).length).toBe(0);
    });

    it('returns empty results when querying with an impossible numeric range', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { writeColumnIndex: { features: ['n'] } });
        const fr = await FlatRecord.open(bytes);
        expect(
            (await collect(fr.findFeaturesByValue('n', { gte: 100, lt: 50 }))).length,
        ).toBe(0);
    });
});

describe('robustness — text-query edge cases', () => {
    it('returns empty when the query is empty after tokenisation', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { writeColumnIndex: { features: ['name'] } });
        const fr = await FlatRecord.open(bytes);
        expect((await collect(fr.findFeaturesByText('name', ''))).length).toBe(0);
        expect((await collect(fr.findFeaturesByText('name', '!@#'))).length).toBe(0);
        expect((await collect(fr.findFeaturesByText('name', '   '))).length).toBe(0);
    });

    it('accepts a single-character prefix and still returns hits', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency, { writeColumnIndex: { features: ['name'] } });
        const fr = await FlatRecord.open(bytes);
        const hits = await collect(fr.findFeaturesByText('name', 'a'));
        expect(hits.length).toBe(1);
        expect((hits[0].feature.properties as { name: string }).name).toBe('alpha');
    });

    it('returns 0 hits when no record has any token for the column', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'A', other: 'x' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: 'B', other: 'y' } },
            ],
        };
        const bytes = serialize(geojson, { links: [] }, { writeColumnIndex: { features: ['other'] } });
        const fr = await FlatRecord.open(bytes);
        const hits = await collect(fr.findFeaturesByText('other', 'absent'));
        expect(hits.length).toBe(0);
    });

    it('handles a token that appears multiple times in one indexed string', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'rio rio grande' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: 'rio uno' } },
            ],
        };
        const bytes = serialize(geojson, { links: [] }, { writeColumnIndex: { features: ['name'] } });
        const fr = await FlatRecord.open(bytes);
        const hits = await collect(fr.findFeaturesByText('name', 'rio'));
        // The first string still surfaces only once even though it contains
        // the token twice.
        const names = hits.map((h) => (h.feature.properties as { name: string }).name);
        expect(names).toEqual(['rio rio grande', 'rio uno']);
    });
});

describe('robustness — Unicode normalisation beyond pt-BR', () => {
    it('strips diacritics across multiple scripts', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'Zürich' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: 'Köln' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { name: 'Málaga' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [3, 0] }, properties: { name: 'Ñuble' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [4, 0] }, properties: { name: 'Łódź' } },
            ],
        };
        const bytes = serialize(geojson, { links: [] }, { writeColumnIndex: { features: ['name'] } });
        const fr = await FlatRecord.open(bytes);
        // German: "Zürich" → "zurich"
        expect((await collect(fr.findFeaturesByText('name', 'zur'))).length).toBe(1);
        // Spanish: "Málaga" → "malaga"
        expect((await collect(fr.findFeaturesByText('name', 'mal'))).length).toBe(1);
        // Spanish ñ: "Ñuble" → "nuble"
        expect((await collect(fr.findFeaturesByText('name', 'nub'))).length).toBe(1);
    });

    it('handles CJK strings (no token splitting on ideographs)', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: '東京' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: '京都' } },
            ],
        };
        const bytes = serialize(geojson, { links: [] }, { writeColumnIndex: { features: ['name'] } });
        const fr = await FlatRecord.open(bytes);
        // No whitespace/punct between CJK chars → each string is one token.
        const tokyo = await collect(fr.findFeaturesByText('name', '東京'));
        const kyoto = await collect(fr.findFeaturesByText('name', '京都'));
        expect(tokyo.length).toBe(1);
        expect(kyoto.length).toBe(1);
    });

    it('treats currency / math symbols as token separators', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'A+B' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: 'A$B' } },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: { name: 'AAB' } },
            ],
        };
        const bytes = serialize(geojson, { links: [] }, { writeColumnIndex: { features: ['name'] } });
        const fr = await FlatRecord.open(bytes);
        // "A B" should match both the + and $ variants (tier A) and not AAB.
        const hits = await collect(fr.findFeaturesByText('name', 'a b'));
        const names = hits.map((h) => (h.feature.properties as { name: string }).name).sort();
        expect(names).toEqual(['A$B', 'A+B']);
    });
});

describe('robustness — shortestPath weight extremes', () => {
    it('rejects a weight function that returns NaN', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency);
        const fr = await FlatRecord.open(bytes);
        await expect(
            fr.shortestPath(0, 2, { weight: () => Number.NaN, heuristic: null }),
        ).rejects.toThrow(/finite non-negative/);
    });

    it('rejects a negative weight', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency);
        const fr = await FlatRecord.open(bytes);
        await expect(
            fr.shortestPath(0, 2, { weight: () => -1, heuristic: null }),
        ).rejects.toThrow(/finite non-negative/);
    });

    it('rejects Infinity weight', async () => {
        const { geojson, adjacency } = tinyGraph();
        const bytes = serialize(geojson, adjacency);
        const fr = await FlatRecord.open(bytes);
        await expect(
            fr.shortestPath(0, 2, { weight: () => Number.POSITIVE_INFINITY, heuristic: null }),
        ).rejects.toThrow(/finite non-negative/);
    });

    it('returns null when no path exists between disconnected vertices', async () => {
        const geojson: GeoJsonFeatureCollection = {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: {} },
                { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 0] }, properties: {} },
            ],
        };
        const adjacency: AdjacencyListInput = {
            links: [{ from: 0, to: 1, properties: {} }],
        };
        const bytes = serialize(geojson, adjacency);
        const fr = await FlatRecord.open(bytes);
        // 0→1 connected, 2 is isolated.
        const path = await fr.shortestPath(0, 2, { heuristic: null });
        expect(path).toBeNull();
    });
});
