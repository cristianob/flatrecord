/**
 * Generate the FlatRecord fixtures used by the test suite.
 *
 * Run with:
 *   pnpm tsx script/gen_fixtures.ts
 *
 * Each fixture is a small, deterministic FlatRecord file that
 * exercises a different combination of write-time flags (with/without
 * vertex R-tree, with/without graph indices, with/without edge
 * geometry). The output lives under `test/data/`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FeatureCollection } from 'geojson';
import { serialize, type Row } from '../src/ts/geojson.js';
import type { AdjacencyListInput } from '../src/ts/link-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'test', 'data');
mkdirSync(OUT_DIR, { recursive: true });

// ─── Fixture 1: cities-network.frb ────────────────────────────────────
// 5 Brazilian capitals connected by a few directed edges. All three
// indices on (the library default). Useful for round-trip + query tests.
{
    const geojson: FeatureCollection = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.633, -23.55] }, properties: { iata: 'SAO', name: 'São Paulo' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.173, -22.907] }, properties: { iata: 'RIO', name: 'Rio de Janeiro' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.929, -15.78] }, properties: { iata: 'BSB', name: 'Brasília' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-38.51, -12.971] }, properties: { iata: 'SSA', name: 'Salvador' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-49.273, -25.428] }, properties: { iata: 'CWB', name: 'Curitiba' } },
        ],
    };
    const adjacency: AdjacencyListInput = {
        links: [
            { from: 0, to: 1, properties: { road: 'BR-116', km: 429 } },
            { from: 0, to: 2, properties: { road: 'BR-050', km: 1015 } },
            { from: 0, to: 4, properties: { road: 'BR-116', km: 408 } },
            { from: 1, to: 3, properties: { road: 'BR-101', km: 1649 } },
            { from: 2, to: 3, properties: { road: 'BR-242', km: 1446 } },
        ],
    };
    const bytes = serialize(geojson, adjacency);
    writeFileSync(resolve(OUT_DIR, 'cities-network.frb'), bytes);
    console.log(`✓ cities-network.frb  ${bytes.byteLength} bytes`);
}

// ─── Fixture 2: grid-with-paths.frb ───────────────────────────────────
// 4×4 grid of points with bidirectional edges + LineString paths on
// some edges. Used for spatial-filter tests and shortest-path tests.
{
    const n = 4;
    const features = [] as FeatureCollection['features'];
    for (let i = 0; i < n * n; i++) {
        const x = -46.6 + (i % n) * 0.01;
        const y = -23.5 + Math.floor(i / n) * 0.01;
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [x, y] },
            properties: { id: i },
        });
    }
    const links: AdjacencyListInput['links'] = [];
    for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
            const here = row * n + col;
            if (col + 1 < n) {
                links.push({ from: here, to: here + 1, properties: { dir: 'E' } });
                links.push({ from: here + 1, to: here, properties: { dir: 'W' } });
            }
            if (row + 1 < n) {
                links.push({ from: here, to: here + n, properties: { dir: 'N' } });
                links.push({ from: here + n, to: here, properties: { dir: 'S' } });
            }
        }
    }
    // Add a straight diagonal edge with explicit LineString geometry
    // between two opposite corners. Two intermediate waypoints (along
    // the same line) exercise the multi-vertex LineString code path
    // while still making the diagonal the shortest path between corners.
    const a = features[0].geometry as { coordinates: number[] };
    const b = features[n * n - 1].geometry as { coordinates: number[] };
    links.push({
        from: 0,
        to: n * n - 1,
        geometry: {
            type: 'LineString',
            coordinates: [
                a.coordinates,
                [
                    a.coordinates[0] + (b.coordinates[0] - a.coordinates[0]) / 3,
                    a.coordinates[1] + (b.coordinates[1] - a.coordinates[1]) / 3,
                ],
                [
                    a.coordinates[0] + (2 * (b.coordinates[0] - a.coordinates[0])) / 3,
                    a.coordinates[1] + (2 * (b.coordinates[1] - a.coordinates[1])) / 3,
                ],
                b.coordinates,
            ],
        },
        properties: { dir: 'diag' },
    });

    const bytes = serialize({ type: 'FeatureCollection', features }, { links });
    writeFileSync(resolve(OUT_DIR, 'grid-with-paths.frb'), bytes);
    console.log(`✓ grid-with-paths.frb ${bytes.byteLength} bytes`);
}

// ─── Fixture 3: no-indices.frb ────────────────────────────────────────
// Same cities graph but written with every index disabled. Used to
// verify lazy/no-index code paths and error messages.
{
    const geojson: FeatureCollection = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.633, -23.55] }, properties: { name: 'A' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.173, -22.907] }, properties: { name: 'B' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.929, -15.78] }, properties: { name: 'C' } },
        ],
    };
    const adjacency: AdjacencyListInput = {
        links: [
            { from: 0, to: 1, properties: {} },
            { from: 1, to: 2, properties: {} },
        ],
    };
    const bytes = serialize(geojson, adjacency, {
        writeSpatialIndex: false,
        writeAdjacencyIndex: false,
        writeLinkSpatialIndex: false,
    });
    writeFileSync(resolve(OUT_DIR, 'no-indices.frb'), bytes);
    console.log(`✓ no-indices.frb      ${bytes.byteLength} bytes`);
}

// ─── Fixture 4: minimal.frb ───────────────────────────────────────────
// Smallest possible FlatRecord file: a single vertex, no edges, no indices at
// all. Used to verify the absolute-minimum format handshake.
{
    const geojson: FeatureCollection = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
        ],
    };
    const bytes = serialize(geojson, undefined, {
        writeSpatialIndex: false,
        writeAdjacencyIndex: false,
        writeLinkSpatialIndex: false,
    });
    writeFileSync(resolve(OUT_DIR, 'minimal.frb'), bytes);
    console.log(`✓ minimal.frb         ${bytes.byteLength} bytes`);
}

// ─── Fixture 5: maximal.frb ───────────────────────────────────────────
// Every index turned on, every property-column type represented on
// both vertices and edges. Stresses the most complex file we can
// produce.
{
    const geojson: FeatureCollection = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.63, -23.55] }, properties: { name: 'São Paulo', icao: 'SBSP', elev_ft: 2461, intl: true } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.17, -22.91] }, properties: { name: 'Rio de Janeiro', icao: 'SBRJ', elev_ft: 11, intl: false } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.93, -15.78] }, properties: { name: 'Brasília', icao: 'SBBR', elev_ft: 3497, intl: true } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-49.27, -16.68] }, properties: { name: 'São José do Rio Preto', icao: 'SBSR', elev_ft: 1784, intl: false } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-44.20, -22.30] }, properties: { name: 'Rio Preto', icao: 'SDRP', elev_ft: 100, intl: false } },
        ],
    };
    const adjacency: AdjacencyListInput = {
        links: [
            { from: 0, to: 1, properties: { road: 'BR-116', km: 429, paved: true } },
            { from: 0, to: 2, properties: { road: 'BR-050', km: 1015, paved: true } },
            { from: 0, to: 3, properties: { road: 'BR-153', km: 442, paved: true } },
            { from: 3, to: 4, properties: { road: 'BR-101', km: 770, paved: false } },
        ],
    };
    const bytes = serialize(geojson, adjacency, {
        writeSpatialIndex: true,
        writeAdjacencyIndex: true,
        writeLinkSpatialIndex: true,
        writeColumnIndex: {
            features: ['name', 'icao', 'elev_ft', 'intl'],
            links: ['road', 'km', 'paved'],
        },
    });
    writeFileSync(resolve(OUT_DIR, 'maximal.frb'), bytes);
    console.log(`✓ maximal.frb         ${bytes.byteLength} bytes`);
}

// ─── Fixture 6: table-users.frb ───────────────────────────────────────
// Pure `table` mode: rows only, no geometry, no links. Indexed text /
// numeric / boolean columns so it exercises every property-index kind
// on a tabular file. Verifies the Row[] input overload + Row[] output.
{
    const rows: Row[] = [
        { id: 'u1', name: 'Alice',  age: 30, vip: true  },
        { id: 'u2', name: 'Bob',    age: 25, vip: false },
        { id: 'u3', name: 'Carol',  age: 45, vip: true  },
        { id: 'u4', name: 'Dan',    age: 18, vip: false },
        { id: 'u5', name: 'Erin',   age: 60, vip: true  },
    ];
    const bytes = serialize(rows, undefined, {
        writeColumnIndex: { features: ['id', 'name', 'age', 'vip'] },
    });
    writeFileSync(resolve(OUT_DIR, 'table-users.frb'), bytes);
    console.log(`✓ table-users.frb     ${bytes.byteLength} bytes`);
}

// ─── Fixture 7: text-search-large.frb ──────────────────────────────
// 5 000 features with a fat indexed text column (~20 words per row,
// drawn from a fixed vocabulary so search assertions are deterministic).
// Exercises text index build / open / query at a non-trivial scale.
// Single seeded LCG so the output is byte-for-byte stable.
{
    const seed = 1337;
    let s = seed;
    const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
    };
    const VOCAB = [
        'industrial', 'magnetic', 'orbital', 'quantum', 'subterranean',
        'tropical', 'urban', 'volcanic', 'arctic', 'maritime',
        'asteroid', 'beacon', 'crater', 'depot', 'estuary',
        'foundry', 'glacier', 'harbor', 'island', 'junction',
        'kingdom', 'lighthouse', 'monolith', 'nebula', 'observatory',
        'plateau', 'quarry', 'reservoir', 'savannah', 'tundra',
        'university', 'valley', 'wharf', 'xenobiology', 'yard', 'ziggurat',
    ];
    const N = 5000;
    const rows: Row[] = Array.from({ length: N }, (_, i) => {
        const wordCount = 18 + Math.floor(rand() * 6);  // 18–23 words
        const words = Array.from({ length: wordCount }, () => VOCAB[Math.floor(rand() * VOCAB.length)]);
        return {
            id: `R${String(i).padStart(5, '0')}`,
            category: VOCAB[i % VOCAB.length],
            score: (i * 13) % 1000,
            description: words.join(' '),
        };
    });
    const bytes = serialize(rows, undefined, {
        writeColumnIndex: { features: ['id', 'category', 'score', 'description'] },
    });
    writeFileSync(resolve(OUT_DIR, 'text-search-large.frb'), bytes);
    console.log(`✓ text-search-large.frb ${bytes.byteLength} bytes (${N} rows)`);
}

// ─── Fixture 8: graph-deps.frb ────────────────────────────────────────
// `graph` mode: tabular rows + a small dependency graph. Exercises
// adjacency CSR + link property index on a geometry-less file.
{
    const rows: Row[] = [
        { pkg: 'app',     version: '1.0.0' },
        { pkg: 'auth',    version: '2.3.1' },
        { pkg: 'db',      version: '4.0.0' },
        { pkg: 'cache',   version: '1.5.2' },
        { pkg: 'logger',  version: '0.9.0' },
    ];
    const adjacency: AdjacencyListInput = {
        links: [
            { from: 0, to: 1, properties: { kind: 'runtime', optional: false } },
            { from: 0, to: 2, properties: { kind: 'runtime', optional: false } },
            { from: 0, to: 4, properties: { kind: 'dev',     optional: true  } },
            { from: 1, to: 2, properties: { kind: 'runtime', optional: false } },
            { from: 1, to: 4, properties: { kind: 'runtime', optional: false } },
            { from: 2, to: 3, properties: { kind: 'runtime', optional: true  } },
            { from: 2, to: 4, properties: { kind: 'runtime', optional: false } },
        ],
    };
    const bytes = serialize(rows, adjacency, {
        writeColumnIndex: {
            features: ['pkg', 'version'],
            links: ['kind', 'optional'],
        },
    });
    writeFileSync(resolve(OUT_DIR, 'graph-deps.frb'), bytes);
    console.log(`✓ graph-deps.frb      ${bytes.byteLength} bytes`);
}

// ─── Fixture 9: with-metadata.frb ─────────────────────────────────────
// All four identity strings + an explicit timestamp populated, so we
// can verify on a pinned file that the reader extracts every header
// field correctly. Frozen timestamp keeps the fixture byte-stable.
{
    const rows: Row[] = [
        { id: 'r1', label: 'Alpha' },
        { id: 'r2', label: 'Beta' },
    ];
    const bytes = serialize(rows, undefined, {
        name: 'fixtures.metadata.demo',
        title: 'FlatRecord metadata fixture',
        description:
            'A tiny tabular file used by the test suite to verify that every header identity string round-trips correctly. Two rows, one indexed column, frozen timestamp.',
        metadata: JSON.stringify({
            source: 'flatrecord/test-fixtures',
            license: 'BSD-2-Clause',
            tags: ['demo', 'metadata', 'roundtrip'],
        }),
        timestamp: 1_700_000_000_000,  // 2023-11-14T22:13:20.000Z — pinned
        writeColumnIndex: { features: ['id', 'label'] },
    });
    writeFileSync(resolve(OUT_DIR, 'with-metadata.frb'), bytes);
    console.log(`✓ with-metadata.frb   ${bytes.byteLength} bytes`);
}

console.log(`\nFixtures written to ${OUT_DIR}`);
