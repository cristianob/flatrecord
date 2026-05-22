/**
 * FlatRecord micro-benchmark suite.
 *
 * Generates a representative dataset (50 000 features in a 1 000-link
 * graph), serializes it once, then times each public-API operation.
 *
 * Run with:
 *
 *   pnpm tsx bench/run.ts
 *
 * Output is human-readable + machine-parseable on stderr (CSV with
 * `BENCH:` prefix lines). Numbers fluctuate ~10 % between runs on a
 * laptop; treat them as orders of magnitude, not as a leaderboard.
 */

import { FlatRecord, serialize } from '../src/ts/geojson.js';
import type { AdjacencyListInput } from '../src/ts/link-types.js';

interface BenchResult {
    label: string;
    n: number;
    totalMs: number;
    perOpUs: number;
}

const results: BenchResult[] = [];

async function bench<T>(label: string, n: number, fn: () => Promise<T> | T): Promise<T> {
    const t0 = performance.now();
    const out = await fn();
    const totalMs = performance.now() - t0;
    const perOpUs = (totalMs * 1000) / n;
    results.push({ label, n, totalMs, perOpUs });
    process.stderr.write(`BENCH: ${label},${n},${totalMs.toFixed(2)},${perOpUs.toFixed(2)}\n`);
    return out;
}

function makeDataset(featureCount: number, linkCount: number): { geojson: any; adj: AdjacencyListInput } {
    // Pseudo-random but deterministic — same numbers every run.
    let seed = 1337;
    const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    };
    const features = Array.from({ length: featureCount }, (_, i) => ({
        type: 'Feature' as const,
        geometry: {
            type: 'Point' as const,
            coordinates: [-60 + rand() * 30, -35 + rand() * 25],
        },
        properties: {
            id: `f${i}`,
            name: `Feature ${i}`,
            category: ['alpha', 'beta', 'gamma', 'delta'][i % 4],
            score: Math.floor(rand() * 1000),
            active: i % 7 === 0,
        },
    }));
    const links: AdjacencyListInput = {
        links: Array.from({ length: linkCount }, (_, i) => ({
            from: i % featureCount,
            to: (i * 7 + 3) % featureCount,
            properties: { weight: rand() * 100, kind: i % 3 === 0 ? 'fast' : 'slow' },
        })).filter((l) => l.from !== l.to),
    };
    return { geojson: { type: 'FeatureCollection', features }, adj: links };
}

async function main() {
    const N = 50_000;
    const M = 1_000;
    process.stderr.write(`\n# Dataset: ${N} features, ${M} links\n`);
    process.stderr.write(`# CSV header: label,n,totalMs,perOpUs\n`);
    process.stderr.write(`BENCH: label,n,totalMs,perOpUs\n`);

    const { geojson, adj } = makeDataset(N, M);

    // ── Write side ───────────────────────────────────────────────
    const bytes = await bench('serialize.full', 1, () =>
        serialize(geojson, adj, {
            writeColumnIndex: {
                features: ['id', 'name', 'category', 'score', 'active'],
                links: ['weight', 'kind'],
            },
        }),
    );
    process.stderr.write(`# File size: ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB\n`);

    // ── Open + preload ──────────────────────────────────────────
    const fr = await bench('open', 1, () => FlatRecord.open(bytes));

    // Random-access cold reads (no preload)
    await bench('getFeature(random) × 1000', 1000, async () => {
        for (let i = 0; i < 1000; i++) await fr.getFeature((i * 47) % N);
    });
    await bench('getFeatures(bulk-100)', 100, async () => {
        const indices = Array.from({ length: 100 }, (_, i) => (i * 503) % N);
        await fr.getFeatures(indices);
    });
    await bench('featuresInBbox(small) × 100', 100, async () => {
        for (let i = 0; i < 100; i++) {
            const x = -50 + (i % 10) * 2;
            const y = -25 + Math.floor(i / 10) * 2;
            const it = fr.featuresInBbox({ minX: x, minY: y, maxX: x + 1, maxY: y + 1 });
            for await (const _ of it) { /* drain */ }
        }
    });
    await bench('nearestFeatures(limit 10) × 100', 100, async () => {
        for (let i = 0; i < 100; i++) {
            let yielded = 0;
            for await (const _ of fr.nearestFeatures([-45 + (i % 10), -22 - (i % 10)], { limit: 10 })) {
                yielded++;
                if (yielded >= 10) break;
            }
        }
    });
    await bench('findFeaturesByText × 100', 100, async () => {
        for (let i = 0; i < 100; i++) {
            const it = fr.findFeaturesByText('name', `feature ${i * 13}`, { limit: 10 });
            for await (const _ of it) { /* drain */ }
        }
    });
    await bench('findFeaturesByValue (range) × 100', 100, async () => {
        for (let i = 0; i < 100; i++) {
            const it = fr.findFeaturesByValue('score', { gte: 100 + i, lt: 200 + i });
            let n = 0;
            for await (const _ of it) if (++n >= 50) break;
        }
    });

    // Link side
    await bench('outgoingLinksOf × 1000', 1000, async () => {
        for (let i = 0; i < 1000; i++) {
            const it = fr.outgoingLinksOf((i * 47) % N);
            for await (const _ of it) { /* drain */ }
        }
    });
    await bench('shortestPath × 10', 10, async () => {
        for (let i = 0; i < 10; i++) {
            await fr.shortestPath((i * 7) % N, (i * 11 + 5) % N);
        }
    });

    // Preload then re-run hot paths
    fr.release();
    await bench('preload', 1, () => fr.preload());
    await bench('getFeature(warm) × 1000', 1000, async () => {
        for (let i = 0; i < 1000; i++) await fr.getFeature((i * 47) % N);
    });

    process.stderr.write('\n# Summary\n');
    process.stderr.write(
        results
            .map((r) => `  ${r.label.padEnd(36)} ${r.totalMs.toFixed(1).padStart(8)} ms  ${r.perOpUs.toFixed(2).padStart(10)} µs/op`)
            .join('\n'),
    );
    process.stderr.write('\n');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
