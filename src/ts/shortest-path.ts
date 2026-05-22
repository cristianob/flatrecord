import type { IGeoJsonFeature } from './geojson/feature.js';
import type { FlatRecord } from './flat-record.js';
import type { Link, LinkProperties } from './link-types.js';

/**
 * Link weight function. Receives the link's properties and the
 * precomputed haversine length of the link (in metres, on the WGS84
 * sphere; always 0 on `graph` mode files where features have no
 * geometry). Return a non-negative finite number — higher means
 * "more costly".
 *
 * Properties come first because they're the common case: most weight
 * functions derive cost from data on the link (`speed_kmh`, `tolls`,
 * `weight`, …) and use `distance` only as a tie-breaker — or ignore
 * it entirely on `graph` mode files.
 */
export type LinkWeightFn = (properties: LinkProperties, distance: number) => number;

/**
 * A* heuristic. Receives the current feature and the target feature.
 * Must be admissible (never overestimate the true remaining cost).
 */
export type HeuristicFn = (feature: IGeoJsonFeature, target: IGeoJsonFeature) => number;

export interface ShortestPathOptions {
    /**
     * Per-link cost. Receives `(properties, distance)` — properties
     * first because that's where most cost models look; `distance` is
     * the precomputed haversine length of the link in metres (always
     * `0` on `graph` mode files). Default depends on the file's mode:
     *  - `geo` / `geograph` (has geometry) → `(_, d) => d` — geodesic
     *    distance in metres.
     *  - `graph` (no geometry) → `() => 1` — unit cost per hop.
     */
    weight?: LinkWeightFn;
    /**
     * A* heuristic. Default depends on the file's mode:
     *  - `geo` / `geograph` (has geometry) → `'haversine'` — straight-
     *    line distance between feature points. Admissible when
     *    `weight(d, …) ≤ d`.
     *  - `graph` (no geometry) → `null` — falls back to plain Dijkstra
     *    (haversine needs coordinates).
     *
     * Pass an explicit `null` to force Dijkstra on a geographic file.
     * Pass a custom `(feature, target) => number` to override the
     * default — the function must never overestimate the true
     * remaining cost in the same units as `weight`.
     */
    heuristic?: HeuristicFn | 'haversine' | null;
}

export interface ShortestPathResult {
    features: IGeoJsonFeature[];
    links: Link[];
    cost: number;
}

const EARTH_RADIUS_M = 6371008.8;

export function haversine(a: [number, number], b: [number, number]): number {
    const toRad = Math.PI / 180;
    const lat1 = a[1] * toRad;
    const lat2 = b[1] * toRad;
    const dLat = (b[1] - a[1]) * toRad;
    const dLon = (b[0] - a[0]) * toRad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

function representativePoint(f: IGeoJsonFeature): [number, number] | null {
    const g = f.geometry as { type: string; coordinates: unknown } | undefined;
    if (!g) return null;
    if (g.type === 'Point') {
        const c = g.coordinates as number[];
        return [c[0], c[1]];
    }
    const c = g.coordinates as unknown;
    if (Array.isArray(c) && c.length > 0) {
        const first = c[0];
        if (typeof first === 'number' && typeof (c as number[])[1] === 'number') {
            return [(c as number[])[0], (c as number[])[1]];
        }
        if (Array.isArray(first) && typeof first[0] === 'number' && typeof first[1] === 'number') {
            return [first[0] as number, first[1] as number];
        }
    }
    return null;
}

function linkHaversineLength(
    link: Link,
    fromFeature: IGeoJsonFeature,
    toFeature: IGeoJsonFeature,
): number {
    if (link.geometry && link.geometry.coordinates.length >= 2) {
        const cs = link.geometry.coordinates;
        let total = 0;
        for (let i = 1; i < cs.length; i++) {
            total += haversine(cs[i - 1] as [number, number], cs[i] as [number, number]);
        }
        return total;
    }
    const a = representativePoint(fromFeature);
    const b = representativePoint(toFeature);
    if (!a || !b) return 0;
    return haversine(a, b);
}

function defaultHeuristic(feature: IGeoJsonFeature, target: IGeoJsonFeature): number {
    const a = representativePoint(feature);
    const b = representativePoint(target);
    if (!a || !b) return 0;
    return haversine(a, b);
}

class MinHeap {
    private nodes: Array<{ cost: number; v: number }> = [];
    push(cost: number, v: number): void {
        this.nodes.push({ cost, v });
        this.siftUp(this.nodes.length - 1);
    }
    pop(): { cost: number; v: number } | undefined {
        if (this.nodes.length === 0) return undefined;
        const root = this.nodes[0];
        const last = this.nodes.pop();
        if (last !== undefined && this.nodes.length > 0) {
            this.nodes[0] = last;
            this.siftDown(0);
        }
        return root;
    }
    get size(): number {
        return this.nodes.length;
    }
    private siftUp(i: number): void {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.nodes[parent].cost <= this.nodes[i].cost) break;
            [this.nodes[parent], this.nodes[i]] = [this.nodes[i], this.nodes[parent]];
            i = parent;
        }
    }
    private siftDown(i: number): void {
        const n = this.nodes.length;
        for (;;) {
            const l = 2 * i + 1;
            const r = 2 * i + 2;
            let smallest = i;
            if (l < n && this.nodes[l].cost < this.nodes[smallest].cost) smallest = l;
            if (r < n && this.nodes[r].cost < this.nodes[smallest].cost) smallest = r;
            if (smallest === i) break;
            [this.nodes[i], this.nodes[smallest]] = [this.nodes[smallest], this.nodes[i]];
            i = smallest;
        }
    }
}

interface PathPredecessor {
    prev: number;
    link: Link;
}

async function search(
    record: FlatRecord,
    from: number,
    to: number,
    weight: LinkWeightFn,
    heuristic: HeuristicFn | null,
): Promise<{ cost: number; predecessor: Map<number, PathPredecessor> } | null> {
    const distances = new Map<number, number>();
    const predecessor = new Map<number, PathPredecessor>();
    const finalized = new Set<number>();
    distances.set(from, 0);

    const target = heuristic ? await record.getFeature(to) : null;
    const heap = new MinHeap();
    if (heuristic && target) {
        const fromFeature = await record.getFeature(from);
        heap.push(heuristic(fromFeature, target), from);
    } else {
        heap.push(0, from);
    }

    while (heap.size > 0) {
        const popped = heap.pop();
        if (!popped) break;
        const u = popped.v;
        if (finalized.has(u)) continue;
        finalized.add(u);
        if (u === to) break;

        const du = distances.get(u) ?? Number.POSITIVE_INFINITY;
        const uFeature = heuristic || record.hasGeometry ? await record.getFeature(u) : null;

        for await (const link of record.outgoingLinksOf(u)) {
            const v = link.to;
            if (finalized.has(v)) continue;
            const vFeature = heuristic || record.hasGeometry ? await record.getFeature(v) : null;
            const distance = uFeature && vFeature ? linkHaversineLength(link, uFeature, vFeature) : 0;
            const w = weight(link.properties, distance);
            if (!Number.isFinite(w) || w < 0) {
                throw new Error(`Link weight must be a finite non-negative number, got ${w}`);
            }
            const newDist = du + w;
            const currentDist = distances.get(v) ?? Number.POSITIVE_INFINITY;
            if (newDist < currentDist) {
                distances.set(v, newDist);
                predecessor.set(v, { prev: u, link });
                const priority =
                    heuristic && vFeature && target ? newDist + heuristic(vFeature, target) : newDist;
                heap.push(priority, v);
            }
        }
    }

    const cost = distances.get(to);
    if (cost === undefined || !Number.isFinite(cost)) return null;
    return { cost, predecessor };
}

async function reconstructPath(
    record: FlatRecord,
    from: number,
    to: number,
    predecessor: Map<number, PathPredecessor>,
): Promise<{ features: IGeoJsonFeature[]; links: Link[] }> {
    const indices: number[] = [to];
    const links: Link[] = [];
    let cur = to;
    while (cur !== from) {
        const p = predecessor.get(cur);
        if (!p) throw new Error('Predecessor chain broken during path reconstruction');
        links.push(p.link);
        indices.push(p.prev);
        cur = p.prev;
    }
    indices.reverse();
    links.reverse();
    const features: IGeoJsonFeature[] = new Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
        features[i] = await record.getFeature(indices[i]);
    }
    return { features, links };
}

export async function runShortestPath(
    record: FlatRecord,
    from: number,
    to: number,
    options: ShortestPathOptions = {},
): Promise<ShortestPathResult | null> {
    if (from < 0 || from >= record.featuresCount) {
        throw new Error(`'from' feature out of range: ${from} (have ${record.featuresCount} features)`);
    }
    if (to < 0 || to >= record.featuresCount) {
        throw new Error(`'to' feature out of range: ${to} (have ${record.featuresCount} features)`);
    }
    if (!record.hasLinks || record.header.linkAdjacencyIndex.length === 0) {
        throw new Error('Adjacency index required for shortestPath. Re-serialize with writeAdjacencyIndex: true.');
    }

    if (from === to) {
        const f = await record.getFeature(from);
        return { features: [f], links: [], cost: 0 };
    }

    // Default weight depends on whether the file has geometry:
    //   - geographic (geo / geograph) → geodesic distance in metres
    //     (per-link haversine length, sum over LineString when present).
    //   - non-geographic (graph) → unit cost per hop. Without
    //     coordinates the haversine distance is always 0, so the
    //     "shortest" path would otherwise be the first reachable one;
    //     hop count is the canonical default for unweighted graphs.
    const weight: LinkWeightFn = options.weight ?? (record.hasGeometry ? (_, d) => d : () => 1);

    // 'haversine' (the default) needs feature geometry. On `graph`
    // files there are no coordinates — Dijkstra is the only sensible
    // default. A custom function passed by the caller is trusted
    // as-is (it can depend on properties instead of geometry).
    const heuristic: HeuristicFn | null =
        options.heuristic === null
            ? null
            : options.heuristic === undefined || options.heuristic === 'haversine'
              ? record.hasGeometry
                  ? defaultHeuristic
                  : null
              : options.heuristic;

    const result = await search(record, from, to, weight, heuristic);
    if (!result) return null;

    const { features, links } = await reconstructPath(record, from, to, result.predecessor);
    return { features, links, cost: result.cost };
}
