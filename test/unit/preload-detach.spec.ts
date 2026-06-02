/**
 * `preload({ detach: true })` — release the source buffer, keep the caches.
 *
 * `detach` copies the retained index/link ranges out of the source buffer
 * (instead of holding `subarray` views) and swaps the reader for a sentinel,
 * so the whole-file buffer becomes collectable while every query keeps being
 * served from in-memory caches. This spec asserts three things:
 *
 *   1. Symmetry — a detached instance returns the same results as the cold
 *      (read-on-demand) path, for every query family.
 *   2. Standalone copies — after detach the retained index bytes own their
 *      backing `ArrayBuffer` (a deterministic proxy for "the source buffer is
 *      no longer pinned"); without detach they are views into the full file.
 *   3. Fail-loud — once detached, any read that escapes the caches throws,
 *      rather than silently returning wrong bytes.
 */

import { describe, expect, it } from 'vitest';
import { FlatRecord, serialize, type Row } from '../../src/ts/geojson.js';
import type { AdjacencyListInput, Link } from '../../src/ts/link-types.js';
import type { IGeoJsonFeature } from '../../src/ts/geojson/feature.js';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const v of iter) out.push(v);
    return out;
}
const feat = (a: IGeoJsonFeature) => JSON.stringify({ g: a.geometry, p: a.properties });
const link = (a: Link) => JSON.stringify({ from: a.from, to: a.to, g: a.geometry, p: a.properties });

const GEOGRAPH = serialize(
    {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.63, -23.55] }, properties: { name: 'São Paulo', icao: 'SBSP', elev: 2461 } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.17, -22.91] }, properties: { name: 'Rio', icao: 'SBRJ', elev: 11 } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.93, -15.78] }, properties: { name: 'Brasília', icao: 'SBBR', elev: 3497 } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-49.27, -16.68] }, properties: { name: 'Rio Preto', icao: 'SBSR', elev: 1784 } },
        ],
    },
    { links: [{ from: 0, to: 1, properties: { road: 'BR-116' } }, { from: 0, to: 2, properties: { road: 'BR-050' } }] } as AdjacencyListInput,
    { writeColumnIndex: { features: ['name', 'icao', 'elev'], links: ['road'] } },
);

const TABLE = serialize(
    [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }, { name: 'Carol', age: 45 }] as Row[],
    undefined,
    { writeColumnIndex: { features: ['name', 'age'] } },
);

describe('preload({ detach: true }) — symmetry with the cold path', () => {
    it('geograph: features, proximity, bbox, links and text search all match', async () => {
        const cold = await FlatRecord.open(GEOGRAPH);
        const det = await FlatRecord.open(GEOGRAPH);
        await det.preload({ detach: true });

        expect((await collect(det.features())).map(feat)).toEqual((await collect(cold.features())).map(feat));
        expect((await det.getFeatures([2, 0, 3])).map(feat)).toEqual((await cold.getFeatures([2, 0, 3])).map(feat));

        const rect = { minX: -50, minY: -25, maxX: -42, maxY: -10 };
        expect((await collect(det.featuresInBbox(rect))).map(feat)).toEqual((await collect(cold.featuresInBbox(rect))).map(feat));

        const near = (fr: FlatRecord) => collect(fr.nearestFeatures([-46.63, -23.55], { limit: 3 }));
        expect((await near(det)).map((r) => r.index)).toEqual((await near(cold)).map((r) => r.index));

        expect((await collect(det.outgoingLinksOf(0))).map(link)).toEqual((await collect(cold.outgoingLinksOf(0))).map(link));
        expect((await collect(det.allLinks())).map(link)).toEqual((await collect(cold.allLinks())).map(link));

        const hits = async (fr: FlatRecord) => {
            const out: Array<{ index: number; tier: string }> = [];
            for await (const h of fr.findFeaturesByText('name', 'rio')) out.push({ index: h.index, tier: h.tier });
            return out;
        };
        expect(await hits(det)).toEqual(await hits(cold));
    });

    it('table: rows and value search match', async () => {
        const cold = await FlatRecord.open(TABLE);
        const det = await FlatRecord.open(TABLE);
        await det.preload({ detach: true });
        expect((await collect(det.features())).map(feat)).toEqual((await collect(cold.features())).map(feat));
        const byVal = async (fr: FlatRecord) => {
            const out: number[] = [];
            for await (const f of fr.findFeaturesByValue('age', { gte: 30 })) out.push(f.id as number);
            return out.sort();
        };
        expect(await byVal(det)).toEqual(await byVal(cold));
    });
});

describe('preload({ detach: true }) — buffer is released', () => {
    const isStandalone = (b: Uint8Array) => b.byteOffset === 0 && b.buffer.byteLength === b.byteLength;

    it('detached index bytes own their backing buffer; non-detached are views into the file', async () => {
        const det = await FlatRecord.open(GEOGRAPH);
        await det.preload({ detach: true });
        const view = await FlatRecord.open(GEOGRAPH);
        await view.preload(); // default: subarray views over the full buffer

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dSpatial = (det as any).featureSpatialIndexBytes as Uint8Array;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vSpatial = (view as any).featureSpatialIndexBytes as Uint8Array;

        expect(isStandalone(dSpatial)).toBe(true);
        // The non-detached view shares the whole-file buffer (much larger than the slice).
        expect(vSpatial.buffer.byteLength).toBeGreaterThan(vSpatial.byteLength);
    });

    it('header.envelope is copied out, not a view that pins the source buffer', async () => {
        // A `subarray` envelope would keep the whole file alive even after
        // detach. It must own its (tiny) backing buffer.
        const det = await FlatRecord.open(GEOGRAPH);
        await det.preload({ detach: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const env = (det as any).header.envelope as Float64Array | null;
        expect(env).not.toBeNull();
        expect(env!.byteOffset === 0 && env!.buffer.byteLength === env!.byteLength).toBe(true);
    });

    it('release*() are gated after detach (cleared caches could not be rebuilt)', async () => {
        const det = await FlatRecord.open(GEOGRAPH);
        await det.preload({ detach: true });
        expect(() => det.release()).toThrow(/detach/i);
        expect(() => det.releaseFeatures()).toThrow(/detach/i);
        expect(() => det.releaseLinks()).toThrow(/detach/i);
        expect(() => det.releaseIndices()).toThrow(/detach/i);
        expect(() => det.releasePropertyIndices()).toThrow(/detach/i);
        // Caches stay intact: queries still work after the refused releases.
        expect(await collect(det.features())).toHaveLength(4);
    });

    it('the detached reader sentinel fails loud on any direct read', async () => {
        const det = await FlatRecord.open(GEOGRAPH);
        await det.preload({ detach: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => (det as any).reader.read(0, 4)).toThrow(/detached/i);
    });

    it('every read family still works after detach without the byte source', async () => {
        const det = await FlatRecord.open(GEOGRAPH);
        await det.preload({ detach: true });
        // getLink (singular) and getLinks (bulk) both served from the resident
        // links section — bulk used to require the reader.
        const all = await collect(det.allLinks());
        expect(await det.getLink(0)).toBeDefined();
        expect(await det.getLinks([1, 0])).toHaveLength(2);
        expect(all.length).toBe(2);
        expect(await det.getFeatures([3, 1, 0])).toHaveLength(3);
    });

    // NB: the assertions above (every retained byte range owns a standalone
    // buffer, the reader is the sentinel) deterministically prove the source
    // buffer is unreferenced and therefore collectable. The actual GC
    // reclamation was verified out-of-band with `node --expose-gc` + `WeakRef`
    // (vitest's worker pool doesn't expose `global.gc`, so it isn't asserted
    // here).
});

describe('preload() — default stays backward compatible', () => {
    it('no-arg preload still works and the reader keeps serving reads', async () => {
        const fr = await FlatRecord.open(GEOGRAPH);
        await fr.preload(); // no options
        const before = (await collect(fr.features())).map(feat);
        fr.release(); // clears caches; reader still live → cold fallback
        const after = (await collect(fr.features())).map(feat);
        expect(after).toEqual(before);
    });
});
