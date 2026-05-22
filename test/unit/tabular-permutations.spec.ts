/**
 * Same exhaustive coverage as `permutations.spec.ts`, but with files
 * that have NO feature geometry. Covers `table` mode (rows, no links)
 * and `graph` mode (rows + links).
 *
 * Without geometry, the writer can't build a feature spatial R-tree
 * or a link spatial R-tree (the latter needs feature/link bboxes).
 * Those flags are still accepted at write time but produce no block.
 * Every spatial-bound method must throw with a "no geometry" error.
 *
 * 64 permutations:
 *   writeAdjacencyIndex × writeReverseAdjacencyIndex
 *     × writeColumnIndexFeatures × writeColumnIndexLinks
 *     × hasLinks × {table/graph mode determined by hasLinks}
 * (writeSpatialIndex / writeLinkSpatialIndex are still toggled but
 *  silently do nothing — we still test that they don't break anything.)
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { deserialize, FlatRecord, serialize, type Row } from '../../src/ts/geojson.js';
import type { AdjacencyListInput } from '../../src/ts/link-types.js';

interface TabFlags {
    writeAdjacencyIndex: boolean;
    writeReverseAdjacencyIndex: boolean;
    writeColumnIndexFeatures: boolean;
    writeColumnIndexLinks: boolean;
    hasLinks: boolean;
    // Toggle "no-op" spatial flags too — they should produce identical
    // output (no spatial index can be built without geometry).
    writeSpatialIndex: boolean;
}

const ROWS: Row[] = [
    { id: 'A', code: 'alpha', score: 10, vip: true },
    { id: 'B', code: 'beta', score: 25, vip: false },
    { id: 'C', code: 'gamma', score: 40, vip: true },
    { id: 'D', code: 'delta', score: 55, vip: false },
    { id: 'E', code: 'epsilon', score: 90, vip: true },
];
const N_ROWS = ROWS.length;

const LINKS: AdjacencyListInput = {
    links: [
        { from: 0, to: 1, properties: { kind: 'fast', cost: 1.5 } },
        { from: 0, to: 2, properties: { kind: 'fast', cost: 2.5 } },
        { from: 1, to: 3, properties: { kind: 'slow', cost: 7.0 } },
        { from: 2, to: 4, properties: { kind: 'fast', cost: 0.5 } },
    ],
};
const N_LINKS = LINKS.links.length;

function build(flags: TabFlags): Uint8Array {
    return serialize(ROWS, flags.hasLinks ? LINKS : undefined, {
        writeSpatialIndex: flags.writeSpatialIndex,
        writeAdjacencyIndex: flags.writeAdjacencyIndex,
        writeReverseAdjacencyIndex: flags.writeReverseAdjacencyIndex,
        writeColumnIndex: {
            features: flags.writeColumnIndexFeatures ? ['id', 'code', 'score', 'vip'] : undefined,
            links: flags.writeColumnIndexLinks ? ['kind', 'cost'] : undefined,
        },
    });
}

const HAS_ADJ = (f: TabFlags) => f.writeAdjacencyIndex && f.hasLinks;
const HAS_REV = (f: TabFlags) => f.writeReverseAdjacencyIndex && f.hasLinks;
const HAS_F_PROP = (f: TabFlags) => f.writeColumnIndexFeatures;
const HAS_L_PROP = (f: TabFlags) => f.writeColumnIndexLinks && f.hasLinks;

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const v of iter) out.push(v);
    return out;
}

const BOOL = [false, true] as const;
const PERMS: TabFlags[] = [];
for (const writeSpatialIndex of BOOL)
    for (const writeAdjacencyIndex of BOOL)
        for (const writeReverseAdjacencyIndex of BOOL)
            for (const writeColumnIndexFeatures of BOOL)
                for (const writeColumnIndexLinks of BOOL)
                    for (const hasLinks of BOOL)
                        PERMS.push({
                            writeSpatialIndex,
                            writeAdjacencyIndex,
                            writeReverseAdjacencyIndex,
                            writeColumnIndexFeatures,
                            writeColumnIndexLinks,
                            hasLinks,
                        });

function label(f: TabFlags): string {
    return [
        f.hasLinks ? 'graph' : 'table',
        f.writeAdjacencyIndex ? 'CSR' : '·',
        f.writeReverseAdjacencyIndex ? 'rCSR' : '·',
        f.writeColumnIndexFeatures ? 'F-Prop' : '·',
        f.writeColumnIndexLinks ? 'L-Prop' : '·',
        f.writeSpatialIndex ? 'F-RTree(noop)' : '·',
    ].join('/');
}

describe('tabular permutations (64 combinations, no geometry)', () => {
    for (const flags of PERMS) {
        describe(label(flags), () => {
            let bytes: Uint8Array;
            let fr: FlatRecord;

            beforeAll(async () => {
                bytes = build(flags);
                fr = await FlatRecord.open(bytes);
            });

            it('mode is inferred correctly', () => {
                expect(fr.mode).toBe(flags.hasLinks ? 'graph' : 'table');
                expect(fr.hasGeometry).toBe(false);
                expect(fr.hasLinks).toBe(flags.hasLinks);
            });

            it('round-trips as rows (no GeoJSON envelope)', async () => {
                const result = await deserialize(bytes);
                if (result.mode !== 'table' && result.mode !== 'graph') {
                    throw new Error(`expected tabular, got ${result.mode}`);
                }
                expect(result.rows).toEqual(ROWS);
                expect(result.adjacencyList.links.length).toBe(flags.hasLinks ? N_LINKS : 0);
            });

            it('feature spatial index was NOT built (no geometry to index)', () => {
                expect(fr.header.featureSpatialIndex.length).toBe(0);
                expect(fr.header.linkSpatialIndex.length).toBe(0);
            });

            it('featuresInBbox throws with "no geometry"', async () => {
                await expect(
                    collect(fr.featuresInBbox({ minX: 0, minY: 0, maxX: 1, maxY: 1 })),
                ).rejects.toThrow(/geometry/i);
            });

            it('linksInBbox throws with "no geometry"-derived error', async () => {
                await expect(
                    collect(fr.linksInBbox({ minX: 0, minY: 0, maxX: 1, maxY: 1 })),
                ).rejects.toThrow(/no link spatial index|no links/i);
            });

            it('nearestFeatures throws on tabular files', async () => {
                await expect(
                    collect(fr.nearestFeatures([0, 0], { limit: 1 })),
                ).rejects.toThrow(/geometry/i);
            });

            it('outgoingLinksOf works iff CSR is present', async () => {
                if (HAS_ADJ(flags)) {
                    const out = await collect(fr.outgoingLinksOf(0));
                    expect(out.length).toBeGreaterThanOrEqual(0);
                } else if (!flags.hasLinks) {
                    await expect(collect(fr.outgoingLinksOf(0))).rejects.toThrow(/no links/i);
                } else {
                    await expect(collect(fr.outgoingLinksOf(0))).rejects.toThrow(
                        /writeAdjacencyIndex/i,
                    );
                }
            });

            it('incomingLinksOf works iff reverse CSR is present', async () => {
                if (HAS_REV(flags)) {
                    const inc = await collect(fr.incomingLinksOf(1));
                    expect(inc.length).toBeGreaterThanOrEqual(0);
                } else if (!flags.hasLinks) {
                    await expect(collect(fr.incomingLinksOf(0))).rejects.toThrow(/no links/i);
                } else {
                    await expect(collect(fr.incomingLinksOf(0))).rejects.toThrow(
                        /writeReverseAdjacencyIndex|reverse adjacency/i,
                    );
                }
            });

            it('shortestPath uses hop-count by default on graph mode', async () => {
                if (HAS_ADJ(flags)) {
                    const path = await fr.shortestPath(0, 2);
                    expect(path).not.toBeNull();
                    expect(path?.cost).toBeGreaterThan(0);  // hop count > 0 between distinct features
                } else if (!flags.hasLinks) {
                    await expect(fr.shortestPath(0, 2)).rejects.toThrow(
                        /adjacency|writeAdjacencyIndex/i,
                    );
                } else {
                    await expect(fr.shortestPath(0, 2)).rejects.toThrow(
                        /writeAdjacencyIndex/i,
                    );
                }
            });

            it('findFeaturesByText works iff vertex property index is present', async () => {
                if (HAS_F_PROP(flags)) {
                    const hits = await collect(fr.findFeaturesByText('code', 'alpha'));
                    expect(hits.length).toBeGreaterThan(0);
                } else {
                    await expect(
                        collect(fr.findFeaturesByText('code', 'alpha')),
                    ).rejects.toThrow(/feature column index|writeColumnIndex/i);
                }
            });

            it('findFeaturesByValue works iff vertex property index is present', async () => {
                if (HAS_F_PROP(flags)) {
                    const hits = await collect(fr.findFeaturesByValue('score', { gte: 50 }));
                    expect(hits.length).toBeGreaterThan(0);
                } else {
                    await expect(
                        collect(fr.findFeaturesByValue('score', { gte: 50 })),
                    ).rejects.toThrow(/feature column index|writeColumnIndex/i);
                }
            });

            it('findLinksByText works iff link property index is present', async () => {
                if (HAS_L_PROP(flags)) {
                    const hits = await collect(fr.findLinksByText('kind', 'fast'));
                    expect(hits.length).toBeGreaterThan(0);
                } else if (!flags.hasLinks) {
                    await expect(collect(fr.findLinksByText('kind', 'fast'))).rejects.toThrow(
                        /no links|link column index|writeColumnIndex/i,
                    );
                } else {
                    await expect(collect(fr.findLinksByText('kind', 'fast'))).rejects.toThrow(
                        /link column index|writeColumnIndex/i,
                    );
                }
            });

            it('outDegreeOf / inDegreeOf return 0 on no-links files', async () => {
                if (!flags.hasLinks) {
                    expect(await fr.outDegreeOf(0)).toBe(0);
                    expect(await fr.inDegreeOf(0)).toBe(0);
                }
            });

            it('inspect() reflects writer flags', () => {
                const info = fr.inspect();
                expect(info.mode).toBe(flags.hasLinks ? 'graph' : 'table');
                expect(info.featuresCount).toBe(N_ROWS);
                expect(info.linksCount).toBe(flags.hasLinks ? N_LINKS : 0);
                expect(info.hasGeometry).toBe(false);
                expect(info.indexes.featureSpatialIndex).toBe(false);
                expect(info.indexes.linkSpatialIndex).toBe(false);
                expect(info.indexes.adjacencyIndex).toBe(HAS_ADJ(flags));
                expect(info.indexes.reverseAdjacencyIndex).toBe(HAS_REV(flags));
                expect(info.crc32.verified).toBe(true);
            });
        });
    }
});
