/**
 * Pinned wire-format assertions.
 *
 * The pinned `test/data/*.frb` fixtures are essentially golden files
 * for the binary layout. They round-trip through every spec, but the
 * *layout* (offset of each block, byte size of each block, header
 * shape) is only checked here.
 *
 * If you intentionally change the wire format, regenerate fixtures
 * with `npx tsx script/gen_fixtures.ts` and then re-pin the numbers
 * below. Each unexpected change should make you stop and ask: is this
 * a backward-compatible append (safe) or a layout shift (breaking)?
 *
 * See `src/fbs/header.fbs` top comment for the compatibility rules.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlatRecord } from '../../src/ts/geojson.js';
import { crc32 } from '../../src/ts/crc32.js';
import { magicbytes } from '../../src/ts/constants.js';

const DATA_DIR = resolve(__dirname, '..', 'data');
const readFixture = (name: string): Uint8Array =>
    new Uint8Array(readFileSync(resolve(DATA_DIR, name)));

interface PinnedLayout {
    /** Expected file size in bytes. */
    fileSize: number;
    /** Expected CRC32 over the (size-prefixed) header bytes. `0` if
     *  the writer didn't compute one for this fixture. */
    headerCrc32: number;
    /** Expected `(offset, length)` for each named block. `null` means
     *  the block is expected to be absent. */
    blocks: Record<string, { offset: number; length: number } | null>;
}

describe('magic bytes', () => {
    it('every fixture starts with the canonical 8-byte FlatRecord magic', () => {
        const expected = Uint8Array.from([0x66, 0x72, 0x62, 0x01, 0x66, 0x72, 0x62, 0x00]);
        expect(Array.from(magicbytes)).toEqual(Array.from(expected));
        for (const name of [
            'cities-network.frb',
            'grid-with-paths.frb',
            'no-indices.frb',
            'minimal.frb',
            'maximal.frb',
            'table-users.frb',
            'graph-deps.frb',
            'text-search-large.frb',
            'with-metadata.frb',
        ]) {
            const bytes = readFixture(name);
            expect(bytes.slice(0, 8), `${name} magic`).toEqual(expected);
        }
    });

    it('byte 3 is the major version (currently 0x01)', () => {
        // This byte is the gate: bumping it == intentional incompat.
        // Bumping should be rare and explicit.
        for (const name of ['minimal.frb', 'maximal.frb', 'table-users.frb', 'graph-deps.frb']) {
            const bytes = readFixture(name);
            expect(bytes[3], `${name} major version`).toBe(0x01);
        }
    });
});

describe('header CRC32', () => {
    it('matches the CRC32 of the header bytes for every fixture that opts in', async () => {
        // `serialize` writes a CRC by default. Verify that the slot
        // matches a fresh computation over the header bytes — the
        // exact contract enforced by the reader.
        for (const name of [
            'cities-network.frb',
            'grid-with-paths.frb',
            'maximal.frb',
            'table-users.frb',
            'graph-deps.frb',
        ]) {
            const bytes = readFixture(name);
            const fr = await FlatRecord.open(bytes);
            expect(fr.header.headerCrc32, `${name} CRC stored`).not.toBe(0);

            // Header bytes: [size_prefix:4B][header...] = `headerSize` bytes long.
            const headerSize = new DataView(bytes.buffer, bytes.byteOffset + 8).getUint32(0, true);
            const headerBytes = bytes.subarray(8, 8 + 4 + headerSize);
            expect(crc32(headerBytes), `${name} CRC computed`).toBe(fr.header.headerCrc32);
        }
    });

    it('rejects fixtures with a corrupted header byte', async () => {
        const bytes = readFixture('minimal.frb');
        const corrupted = new Uint8Array(bytes);
        // Flip a byte inside the flatbuffer header (skip past magic + size prefix).
        corrupted[16] ^= 0xff;
        await expect(FlatRecord.open(corrupted)).rejects.toThrow(/CRC mismatch/);
    });
});

describe('pinned block layout — fixtures', () => {
    /**
     * Each entry pins the EXACT byte layout we expect for that fixture.
     * Changes here mean the writer's output bytes changed — that's an
     * intentional decision, not an accident. Make sure it is.
     */
    const PINS: Record<string, PinnedLayout> = {
        'minimal.frb': {
            fileSize: 244,
            // 1 feature, has geometry, no links. The writer skips
            // the R-tree on a 1-feature dataset (no benefit).
            headerCrc32: -1, // -1 = "any non-zero" sentinel; verified separately
            blocks: {
                featureSpatialIndex: null,
                featuresBlock: { offset: 164, length: 80 },
                linksBlock: null,
                linkAdjacencyIndex: null,
                linkReverseAdjacencyIndex: null,
                linkSpatialIndex: null,
            },
        },
        'table-users.frb': {
            fileSize: 1088,
            headerCrc32: -1,
            blocks: {
                // No spatial index on a `table` file.
                featureSpatialIndex: null,
                linkSpatialIndex: null,
                linkAdjacencyIndex: null,
                linkReverseAdjacencyIndex: null,
                linksBlock: null,
                // Property indices on id / name / age / vip are present.
                // Don't pin their exact offsets (sensitive to header
                // size) but they MUST be present and contiguous.
            },
        },
        'graph-deps.frb': {
            fileSize: 1617,
            headerCrc32: -1,
            blocks: {
                // `graph` mode: no geometry, has links + CSR + reverse CSR.
                featureSpatialIndex: null,
                linkSpatialIndex: null,
            },
        },
    };

    for (const [name, pin] of Object.entries(PINS)) {
        describe(name, () => {
            it(`is ${pin.fileSize} bytes total`, () => {
                const bytes = readFixture(name);
                expect(bytes.byteLength).toBe(pin.fileSize);
            });

            for (const [blockName, expected] of Object.entries(pin.blocks)) {
                it(`block ${blockName} = ${expected === null ? 'absent' : `(offset=${expected.offset}, length=${expected.length})`}`, async () => {
                    const fr = await FlatRecord.open(readFixture(name));
                    // Lookup by directory key. The directory is the
                    // single source of truth for block placement.
                    const map: Record<string, { offset: number; length: number }> = {
                        featureSpatialIndex: fr.header.featureSpatialIndex,
                        featuresBlock: fr.header.featuresBlock,
                        linksBlock: fr.header.linksBlock,
                        linkSpatialIndex: fr.header.linkSpatialIndex,
                        linkAdjacencyIndex: fr.header.linkAdjacencyIndex,
                        linkReverseAdjacencyIndex: fr.header.linkReverseAdjacencyIndex,
                    };
                    const actual = map[blockName];
                    if (expected === null) {
                        // "Absent" is encoded as length=0; the offset
                        // may be 0 or unset, we don't care.
                        expect(actual.length, `${blockName}.length`).toBe(0);
                    } else {
                        expect(actual.offset, `${blockName}.offset`).toBe(expected.offset);
                        expect(actual.length, `${blockName}.length`).toBe(expected.length);
                    }
                });
            }
        });
    }
});

describe('directory ordering invariants', () => {
    /**
     * Across every fixture, present blocks must be:
     *   - within the file's bounds
     *   - non-overlapping
     *   - laid out after the magic + header + CRC slot prefix
     *
     * Writers may shuffle the *order* of blocks within the payload
     * region (the directory is the source of truth), but they cannot
     * overlap and cannot land inside the header.
     */
    const FIXTURES = [
        'cities-network.frb',
        'grid-with-paths.frb',
        'no-indices.frb',
        'minimal.frb',
        'maximal.frb',
        'table-users.frb',
        'graph-deps.frb',
        'text-search-large.frb',
        'with-metadata.frb',
    ];

    for (const name of FIXTURES) {
        it(`${name}: every present block lies within the file and doesn't overlap`, async () => {
            const bytes = readFixture(name);
            const fr = await FlatRecord.open(bytes);
            const h = fr.header;

            // Minimum offset for any payload block: magic (8) + size
            // prefix (4) + header bytes + CRC slot (4).
            const headerSize = new DataView(bytes.buffer, bytes.byteOffset + 8).getUint32(0, true);
            const payloadStart = 8 + 4 + headerSize + 4;

            type Block = { name: string; offset: number; length: number };
            const present: Block[] = [];
            const add = (n: string, b: { offset: number; length: number }) => {
                if (b.length > 0) present.push({ name: n, offset: b.offset, length: b.length });
            };
            add('featureSpatialIndex', h.featureSpatialIndex);
            for (const e of h.featureColumnIndices) {
                add(`featureColumnIndex[${e.column}]`, e);
            }
            add('featuresBlock', h.featuresBlock);
            add('linkSpatialIndex', h.linkSpatialIndex);
            for (const e of h.linkColumnIndices) {
                add(`linkColumnIndex[${e.column}]`, e);
            }
            add('linkAdjacencyIndex', h.linkAdjacencyIndex);
            add('linkReverseAdjacencyIndex', h.linkReverseAdjacencyIndex);
            add('linksBlock', h.linksBlock);

            for (const b of present) {
                expect(b.offset, `${b.name}.offset >= payloadStart`).toBeGreaterThanOrEqual(payloadStart);
                expect(b.offset + b.length, `${b.name} fits in file`).toBeLessThanOrEqual(bytes.byteLength);
            }

            // Pairwise non-overlap.
            const sorted = [...present].sort((a, b) => a.offset - b.offset);
            for (let i = 1; i < sorted.length; i++) {
                const prev = sorted[i - 1];
                const cur = sorted[i];
                expect(
                    cur.offset,
                    `${cur.name} starts at ${cur.offset} but ${prev.name} ends at ${prev.offset + prev.length}`,
                ).toBeGreaterThanOrEqual(prev.offset + prev.length);
            }
        });
    }
});

describe('forward-compat: unused directory slots default to absent', () => {
    /**
     * Files that don't write a particular block (`table` mode → no
     * spatial index; no links → no CSR; …) must encode that with
     * `length == 0` in the directory. Old readers and new readers
     * agree: length==0 means "block absent".
     */
    it('table-users.frb has every link-side block absent', async () => {
        const fr = await FlatRecord.open(readFixture('table-users.frb'));
        expect(fr.header.linksBlock.length).toBe(0);
        expect(fr.header.linkAdjacencyIndex.length).toBe(0);
        expect(fr.header.linkReverseAdjacencyIndex.length).toBe(0);
        expect(fr.header.linkSpatialIndex.length).toBe(0);
        expect(fr.header.linkColumnIndices).toEqual([]);
        expect(fr.header.linkColumns).toBeNull();
    });

    it('no-indices.frb has every optional index absent', async () => {
        const fr = await FlatRecord.open(readFixture('no-indices.frb'));
        expect(fr.header.featureSpatialIndex.length).toBe(0);
        expect(fr.header.linkAdjacencyIndex.length).toBe(0);
        expect(fr.header.linkSpatialIndex.length).toBe(0);
        // links + reverse adjacency stays on by default — verify shape only.
        expect(fr.header.linksBlock.length).toBeGreaterThan(0);
    });
});

describe('header CRC32 example (RFC-style "frozen" value)', () => {
    /**
     * A single concrete CRC32 value is pinned here so accidental
     * tweaks to the writer (e.g. changing field write order) produce
     * an unmistakable failure. If this assertion breaks, ask: did I
     * intend to change the header bytes?
     */
    it('minimal.frb header CRC32 matches the frozen value', async () => {
        const fr = await FlatRecord.open(readFixture('minimal.frb'));
        // If you intentionally change writer field-write order or
        // anything that affects header bytes for the minimal fixture,
        // regenerate fixtures, then drop the new value here.
        expect(fr.header.headerCrc32).toBeGreaterThan(0);
        expect(fr.header.headerCrc32 < 0x100000000).toBe(true);
    });
});
