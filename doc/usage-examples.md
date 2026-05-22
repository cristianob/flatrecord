# FlatRecord — usage examples

Task-oriented cookbook. For the canonical API reference see
[`api-reference.md`](api-reference.md); for the wire format see
[`format-spec.md`](format-spec.md).

## Table of contents

- [Installation](#installation)
- [Quick start (each mode)](#quick-start-each-mode)
- [Working with links](#working-with-links)
- [Indices and writer options](#indices-and-writer-options)
- [Random-access patterns](#random-access-patterns)
- [Property-index searches](#property-index-searches)
- [Shortest path](#shortest-path)
- [Cache lifecycle: cold, warm, preloaded](#cache-lifecycle-cold-warm-preloaded)
- [Diagnostics: `inspect()` + CRC32](#diagnostics-inspect--crc32)
- [Schema validation](#schema-validation)
- [Header timestamp](#header-timestamp)
- [Remote files (HTTP / custom byte sources)](#remote-files-http--custom-byte-sources)
- [Integration with graph libraries](#integration-with-graph-libraries)
- [Real-world examples](#real-world-examples)
- [Browser usage](#browser-usage)

## Installation

```bash
npm install flatrecord
# or
pnpm add flatrecord
# or
yarn add flatrecord
```

ESM only. Supports Node ≥ 18, modern browsers, and React Native.

## Quick start (each mode)

The same `serialize` / `deserialize` / `FlatRecord` API serves all
four modes. The mode is inferred from your data — there's no flag.

### `table` — pure tabular records

```typescript
import { serialize, deserialize, FlatRecord, type Row } from 'flatrecord/geojson';

const users: Row[] = [
    { id: 'u1', name: 'Alice', age: 30, vip: true },
    { id: 'u2', name: 'Bob',   age: 25, vip: false },
];

const bytes = serialize(users, undefined, {
    writeColumnIndex: { features: ['id', 'name', 'age', 'vip'] },
});

const result = await deserialize(bytes);
if (result.mode === 'table' || result.mode === 'graph') {
    console.log(result.rows);   // [{ id: 'u1', ... }, ...]
}

// Or query lazily:
const fr = await FlatRecord.open(bytes);
console.log(fr.mode);   // 'table'
for await (const hit of fr.findFeaturesByText('name', 'alice')) {
    console.log(hit.feature.properties);
}
```

### `geo` — GeoJSON-style features

```typescript
const airports = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.47, -23.43] }, properties: { iata: 'GRU', name: 'Guarulhos' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.24, -22.81] }, properties: { iata: 'GIG', name: 'Galeão' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.91, -15.87] }, properties: { iata: 'BSB', name: 'Brasília' } },
    ],
};

const bytes = serialize(airports, undefined, {
    writeColumnIndex: { features: ['iata', 'name'] },
});

const fr = await FlatRecord.open(bytes);
fr.mode;   // 'geo'

// Spatial filter
for await (const f of fr.featuresInBbox({ minX: -47, minY: -24, maxX: -46, maxY: -23 })) {
    console.log(f.properties.iata);
}

// Nearest
for await (const r of fr.nearestFeatures([-46, -23.5], { limit: 2, unit: 'kilometers' })) {
    console.log(r.feature.properties.iata, `${r.distance.toFixed(1)} km`);
}
```

### `graph` — abstract networks (no coordinates)

```typescript
const packages: Row[] = [
    { pkg: 'app',    version: '1.0.0' },
    { pkg: 'auth',   version: '2.3.1' },
    { pkg: 'db',     version: '4.0.0' },
    { pkg: 'logger', version: '0.9.0' },
];
const adjacency = {
    links: [
        { from: 0, to: 1, properties: { kind: 'runtime' } },
        { from: 0, to: 2, properties: { kind: 'runtime' } },
        { from: 1, to: 2, properties: { kind: 'runtime' } },
        { from: 2, to: 3, properties: { kind: 'runtime' } },
    ],
};

const bytes = serialize(packages, adjacency, {
    writeColumnIndex: { features: ['pkg'], links: ['kind'] },
});

const fr = await FlatRecord.open(bytes);
fr.mode;   // 'graph'

// Hop count default — no geometry, no haversine.
const path = await fr.shortestPath(
    { column: 'pkg', value: 'app' },
    { column: 'pkg', value: 'logger' },
);
console.log(path?.features.map((f) => f.properties.pkg));  // ['app', 'db', 'logger']
```

### `geograph` — geospatial graphs

```typescript
const cities = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.63, -23.55] }, properties: { name: 'São Paulo', icao: 'SBSP' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.17, -22.91] }, properties: { name: 'Rio',       icao: 'SBRJ' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.93, -15.78] }, properties: { name: 'Brasília',  icao: 'SBBR' } },
    ],
};
const roads = {
    links: [
        { from: 0, to: 1, properties: { road: 'BR-116', km: 429 } },
        { from: 0, to: 2, properties: { road: 'BR-050', km: 1015 } },
    ],
};

const fr = await FlatRecord.open(
    serialize(cities, roads, { writeColumnIndex: { features: ['icao'] } }),
);
fr.mode;   // 'geograph'

// A* with haversine, weight = geodesic distance in metres
const path = await fr.shortestPath(
    { column: 'icao', value: 'SBSP' },
    { column: 'icao', value: 'SBBR' },
);
console.log(`${(path!.cost / 1000).toFixed(0)} km via ${path!.features.map(f => f.properties.name).join(' → ')}`);
```

## Working with links

### Directed links

Every link is directed (`from → to`). For bidirectional connections, emit two links:

```typescript
const adj = {
    links: [
        { from: 0, to: 1, properties: { dir: 'fwd' } },
        { from: 1, to: 0, properties: { dir: 'rev' } },
    ],
};
```

### Validation

`serialize` throws on:

```typescript
// Self-loop
{ links: [{ from: 0, to: 0 }] };
// Out-of-range
{ links: [{ from: 0, to: 9999 }] };
// LineString with < 2 coords
{ links: [{ from: 0, to: 1, geometry: { type: 'LineString', coordinates: [[0,0]] } }] };
```

### Link properties

Every column type from the FlatGeobuf encoding is supported:

```typescript
const link = {
    from: 0,
    to: 1,
    properties: {
        count: 42,                                // Double (default for numbers)
        name: 'Main Road',                        // String
        active: true,                             // Bool
        created_at: '2024-01-15T10:30:00Z',       // DateTime (ISO 8601 string)
        metadata: { source: 'osm', v: 2 },        // Json (object → JSON.stringify)
        signature: new Uint8Array([0x01, 0x02]),  // Binary
    },
};
```

Reading back:

```typescript
const result = await deserialize(bytes);
result.adjacencyList.links.forEach(l => {
    console.log(`${l.from} → ${l.to}`, l.properties);
});
```

### Optional LineString geometry on a link

Links may carry an explicit path; without it, consumers treat the link as a straight segment.

```typescript
const adj = {
    links: [
        // Straight segment between endpoints
        { from: 0, to: 1, properties: { road: 'fast lane' } },

        // Explicit curved path
        {
            from: 1, to: 2,
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-46.5, -23.5], [-46.45, -23.48], [-46.42, -23.46], [-46.4, -23.45],
                ],
            },
            properties: { road: 'Serra do Mar' },
        },
    ],
};
```

Constraints: `LineString` only, ≥ 2 coordinates, 2D `[x, y]`.

## Indices and writer options

All `serialize` options:

```typescript
serialize(geojsonOrRows, adjacency, {
    crsCode: 4326,                          // EPSG code (default WGS84)
    writeSpatialIndex: true,                // feature R-tree
    writeAdjacencyIndex: true,              // forward link CSR
    writeReverseAdjacencyIndex: true,       // reverse link CSR (in-degree)
    writeLinkSpatialIndex: true,            // link R-tree
    writeColumnIndex: {
        features: ['name', 'code', 'tier'],
        links: ['kind', 'weight'],
    },
    writeHeaderCrc: true,                   // CRC32 over header bytes
    schema: { features: { /* … */ }, links: { /* … */ } },  // explicit validation
    timestamp: 'now',                       // or a number, or omit
});

// Minimal "no indices" file:
serialize(geojson, adjacency, {
    writeSpatialIndex: false,
    writeAdjacencyIndex: false,
    writeReverseAdjacencyIndex: false,
    writeLinkSpatialIndex: false,
});
```

`writeSpatialIndex: true` reorders features along the Hilbert curve and auto-remaps `link.from` / `link.to` so references stay consistent. `writeAdjacencyIndex: true` sorts links by `from` (stably, so input order is preserved within each feature).

## Random-access patterns

`FlatRecord.open()` reads the header (one range request) and parses
the directory. Every other read is targeted: features, links, indices,
and CRS are fetched lazily as needed.

```typescript
import { FlatRecord } from 'flatrecord/geojson';

const fr = await FlatRecord.open(bytes);
// Equivalent on a remote URL:
// const fr = await FlatRecord.open(byteReaderFromUrl('https://...'));
```

### Single fetch

```typescript
const f = await fr.getFeature(42);          // single feature
const l = await fr.getLink(7);              // single link
const out = await fr.outDegreeOf(42);       // O(1) via CSR
const inc = await fr.inDegreeOf(42);        // O(1) via reverse CSR
const link = await fr.linkIndexBetween(0, 1);  // null when no such link
```

### Bulk fetch (range coalescing)

When you know N specific indices, `getFeatures` / `getLinks` merge
adjacent byte ranges into single reads — important on remote files
where N round-trips would otherwise dominate.

```typescript
const features = await fr.getFeatures([3, 7, 7, 0, 49]);  // duplicates OK
const links = await fr.getLinks([2, 5, 11]);
```

### Spatial: bbox

```typescript
for await (const f of fr.featuresInBbox({ minX: -47, minY: -24, maxX: -46, maxY: -23 })) {
    console.log(f.properties);
}

for await (const l of fr.linksInBbox(rect)) {
    // Returns every link whose stored bbox intersects rect — including
    // LineString links that only partially cross.
}
```

### Spatial: nearest

```typescript
// First 5 closest, distances in metres
for await (const r of fr.nearestFeatures([-46, -23], { limit: 5 })) {
    console.log(r.feature.properties.name, `${r.distance.toFixed(0)} m`);
}

// Everything within 80 km
for await (const r of fr.nearestFeatures([-46, -23], {
    unit: 'kilometers',
    maxDistance: 80,
    limit: Infinity,    // default is 100; opt out for "every match"
})) {
    console.log(r.feature.properties.name, `${r.distance.toFixed(1)} km`);
}

// Nautical miles also supported
for await (const r of fr.nearestFeatures([-46, -23], { unit: 'nautical_miles', limit: 3 })) {
    console.log(r.feature.properties.name, `${r.distance.toFixed(1)} nm`);
}
```

The R-tree only expands as you iterate — early `break` leaves distant blocks untouched.

### Graph traversal

```typescript
for await (const link of fr.outgoingLinksOf(v)) {
    console.log(`${v} → ${link.to}`, link.properties);
}

for await (const link of fr.incomingLinksOf(v)) {
    console.log(`${link.from} → ${v}`, link.properties);
}

// Whole link section in storage order
for await (const link of fr.allLinks()) { /* … */ }
```

## Property-index searches

Declare which columns to index at write time. Three kinds — text, numeric, boolean — chosen at write time from each value's runtime type.

### Text — tier-ranked, multi-token

```typescript
const fr = await FlatRecord.open(bytes);

// Default match: 'prefix' — each query token may match by prefix
for await (const hit of fr.findFeaturesByText('name', 'rio pre')) {
    // hit.tier: 'A' (consecutive in query order) > 'B' (in order, gaps)
    //          > 'C' (any order)
    // hit.index: storage index — feed into getFeature/outgoingLinksOf/etc.
    console.log(hit.tier, hit.feature.properties.name);
}

// match: 'token' — each query token must equal an indexed token exactly
for await (const hit of fr.findFeaturesByText('icao', 'sbsp', { match: 'token' })) { /* … */ }

// match: 'exact' — full string match
for await (const hit of fr.findFeaturesByText('id', 'u42', { match: 'exact' })) { /* … */ }
```

Text normalization: NFKD + diacritic strip + lowercase + tokenize on whitespace/punctuation. `"São José"` indexed under `["sao", "jose"]`; query `"sao jose"` matches at tier A.

### Numeric / boolean — range + equality

```typescript
// Range
for await (const f of fr.findFeaturesByValue('elev_ft', { gte: 1000, lt: 5000 })) { /* … */ }

// Equality
for await (const f of fr.findFeaturesByValue('vip', { eq: true })) { /* … */ }

// Limit
for await (const f of fr.findFeaturesByValue('elev_ft', { gte: 0 }, { limit: 100 })) { /* … */ }
```

Same predicates on `findLinksByValue(column, predicate)`.

### Lookup → index helper

```typescript
const idx = await fr.featureIndexBy({ column: 'icao', value: 'SBSP' });
// idx is a number; pass to outgoingLinksOf / getFeature / shortestPath.
```

`shortestPath` accepts the same descriptor inline:

```typescript
const path = await fr.shortestPath(
    { column: 'icao', value: 'SBSP' },
    { column: 'icao', value: 'SBBR' },
);
```

## Shortest path

```typescript
interface ShortestPathOptions {
    weight?: (properties: LinkProperties, distance: number) => number;
    heuristic?: 'haversine' | ((feature, target) => number) | null;
}
```

`weight(properties, distance)` — properties first because that's where most cost models look. `distance` is the precomputed haversine length of the link in metres (always `0` on `graph` mode files). Defaults:

- `geo` / `geograph` (has geometry) → `(_, d) => d` — geodesic distance in metres
- `graph` (no geometry) → `() => 1` — hop count

```typescript
// Simplest call — A* with haversine heuristic, weight = geodesic metres
const path = await fr.shortestPath(0, 5);

// Travel time at the road's speed limit
const fast = await fr.shortestPath(0, 5, {
    weight: (props, distance) => distance / (Number(props.speed_kmh ?? 50) * 1000 / 3600),
    heuristic: null,    // distance is metres but weight is seconds — disable haversine
});

// Avoid optional dependencies in a package graph
const strict = await fr.shortestPath(
    { column: 'pkg', value: 'app' },
    { column: 'pkg', value: 'cache' },
    { weight: (props) => (props.optional ? 100 : 1) },
);
```

> **Admissibility note.** The default haversine heuristic is only admissible when `weight(props, d) ≤ d`. If your weight is in arbitrary units (travel time, hop count, monetary cost, …), pass `heuristic: null` (Dijkstra) or supply a custom admissible heuristic in the same units as `weight`.

## Cache lifecycle: cold, warm, preloaded

Every read populates caches on the way. The eager helpers below front-load the work; release helpers free memory. Every method is idempotent.

| Method | Issues I/O | Touches |
| --- | --- | --- |
| `loadFeatures()` | 1 bulk read | feature cache |
| `loadLinks()` | 2 parallel reads | links block + forward CSR |
| `loadIndices()` | 1 read per index | feature/link R-trees + forward/reverse CSR |
| `loadFeatureColumnIndex(name)` / `loadLinkColumnIndex(name)` | 1 read | one column's property index |
| `loadPropertyIndices()` | 1 read per declared column (parallel) | every property index |
| `preload()` | 1 read (via `readAll`) or 1 range read covering all blocks | everything |
| `release()` / `releaseFeatures()` / `releaseLinks()` / `releaseIndices()` / `releasePropertyIndices()` | no | one cache (or all) |

```typescript
await fr.preload();            // one round trip on supported byte readers
// Every subsequent query is zero-I/O.
const f0 = await fr.getFeature(0);
const path = await fr.shortestPath(0, 9999);

fr.release();                  // give memory back
// fr is still usable — next query is cold again.
```

> **Remote caveat.** `preload` transfers essentially the entire file. Use only when the data fits in memory and you intend to query enough of it. For multi-gigabyte files keep relying on lazy methods; `loadIndices()` is a useful middle ground (R-trees in memory, payloads still lazy).

## Diagnostics: `inspect()` + CRC32

```typescript
const info = fr.inspect();
console.log(info.mode, info.featuresCount, info.linksCount);
console.log(info.indexes);
// {
//   featureSpatialIndex: true,
//   linkSpatialIndex: true,
//   adjacencyIndex: true,
//   reverseAdjacencyIndex: true,
//   featureColumnIndices: ['name', 'icao'],
//   linkColumnIndices: ['road'],
// }

console.table(info.blocks);
// each row: { block, offset, length, percent }
//   featureSpatialIndex          12345    240   1.2
//   featureColumnIndex[name]     12585    300   1.5
//   ...
```

CRC32 is computed and verified automatically on `FlatRecord.open()`. A corrupted header throws:

```typescript
const corrupted = new Uint8Array(bytes);
corrupted[16] ^= 0xff;
await FlatRecord.open(corrupted);   // throws: "header CRC mismatch ..."
```

Disable with `writeHeaderCrc: false` if you have your own integrity strategy.

## Schema validation

Pass an explicit `schema` to enforce types / required / nullable at write time:

```typescript
import { serialize, type SchemaSpec } from 'flatrecord/geojson';

const schema: SchemaSpec = {
    features: {
        id:   { type: 'String', required: true, nullable: false },
        age:  { type: 'Int' },
        vip:  { type: 'Bool' },
    },
    links: {
        weight: { type: 'Double', required: true },
        kind:   { type: 'String' },
    },
};

// Throws on type mismatch, unknown column, missing required, or null
// in a non-nullable field — caught at write time, not at read time.
serialize(rows, adjacency, { schema });
```

Column types: `Bool`, `Byte`, `UByte`, `Short`, `UShort`, `Int`, `UInt`, `Long`, `ULong`, `Float`, `Double`, `String`, `Json`, `DateTime`, `Binary`.

## Header timestamp

```typescript
// Stamp the file with Date.now() at write time
const bytes = serialize(records, adjacency, { timestamp: 'now' });

// Custom timestamp (Unix-ms)
const bytes2 = serialize(records, adjacency, { timestamp: 1700000000000 });

// Read back
const fr = await FlatRecord.open(bytes);
console.log(fr.header.timestamp);             // number — milliseconds since epoch
console.log(new Date(fr.header.timestamp!));  // Date object
```

When the writer didn't set one, `fr.header.timestamp === null`.

## Remote files (HTTP / custom byte sources)

```typescript
import { FlatRecord, byteReaderFromUrl } from 'flatrecord/geojson';

const fr = await FlatRecord.open(byteReaderFromUrl('https://example.com/network.frb'));

// Lazy queries over HTTP Range requests
const v0 = await fr.getFeature(0);                       // 1 range request
for await (const f of fr.featuresInBbox(rect)) { /* … */ }  // R-tree walk over ranges

// One round-trip for the whole file (when readAll is supported, otherwise
// one combined Range request covering every block)
await fr.preload();
```

Custom byte sources: implement `ByteReader` for any backend (Node `fs`, mmap, IndexedDB, …).

```typescript
import { FlatRecord, type ByteReader } from 'flatrecord/geojson';
import { promises as fs } from 'node:fs';

const handle = await fs.open('huge.frb', 'r');
const reader: ByteReader = {
    async read(offset, length) {
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, offset);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
    async readAll() {
        return new Uint8Array(await fs.readFile('huge.frb'));
    },
};
const fr = await FlatRecord.open(reader);
```

`readAll` is optional but recommended — it makes `preload()` a single round-trip.

## Integration with graph libraries

Convert to your favourite graph library after `deserialize` or after walking `allLinks()`.

```typescript
// Graphology
import Graph from 'graphology';

const result = await deserialize(bytes);
const g = new Graph({ type: 'directed' });
if (result.mode === 'geo' || result.mode === 'geograph') {
    result.features.forEach((f, i) => g.addNode(i, f.properties));
}
result.adjacencyList.links.forEach(l => g.addEdge(l.from, l.to, l.properties));
```

```typescript
// Cytoscape.js
import cytoscape from 'cytoscape';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = []; for await (const v of iter) out.push(v); return out;
}

const fr = await FlatRecord.open(bytes);
const features = await collect(fr.features());
const links = await collect(fr.allLinks());
const elements = [
    ...features.map((f, i) => ({
        data: { id: String(i), ...f.properties },
        position: f.geometry?.type === 'Point'
            ? { x: f.geometry.coordinates[0], y: f.geometry.coordinates[1] }
            : undefined,
    })),
    ...links.map(l => ({
        data: { id: `${l.from}-${l.to}`, source: String(l.from), target: String(l.to), ...l.properties },
    })),
];
cytoscape({ container: el, elements });
```

## Real-world examples

### Road network (geograph)

```typescript
const network = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.63, -23.55] }, properties: { name: 'São Paulo',  pop: 12_300_000 } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.17, -22.91] }, properties: { name: 'Rio',        pop:  6_700_000 } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.93, -15.78] }, properties: { name: 'Brasília',   pop:  3_000_000 } },
    ],
};
const roads = {
    links: [
        { from: 0, to: 1, properties: { road: 'BR-116', km: 429, speed_kmh: 110, toll: true } },
        { from: 0, to: 2, properties: { road: 'BR-050', km: 1015, speed_kmh: 110, toll: true } },
    ],
};

const bytes = serialize(network, roads, {
    writeColumnIndex: { features: ['name', 'pop'], links: ['road', 'speed_kmh', 'toll'] },
});
const fr = await FlatRecord.open(bytes);

// Fastest path (travel time)
const fastest = await fr.shortestPath(0, 2, {
    weight: (props, d) => d / (Number(props.speed_kmh ?? 60) * 1000 / 3600),
    heuristic: null,
});
console.log(`${(fastest!.cost / 60).toFixed(0)} min via ${fastest!.features.map(f => f.properties.name).join(' → ')}`);

// Avoid tolls
const cheapest = await fr.shortestPath(0, 2, {
    weight: (props, d) => (props.toll ? d * 2 : d),
});
```

### Flight routes (geograph + property search)

```typescript
const airports = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.47, -23.43] }, properties: { iata: 'GRU', city: 'São Paulo', intl: true } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.24, -22.81] }, properties: { iata: 'GIG', city: 'Rio',        intl: true } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.91, -15.87] }, properties: { iata: 'BSB', city: 'Brasília',   intl: true } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-49.27, -25.53] }, properties: { iata: 'CWB', city: 'Curitiba',   intl: false } },
    ],
};
const routes = {
    links: [
        { from: 0, to: 1, properties: { airline: 'LATAM', duration_min: 55 } },
        { from: 0, to: 2, properties: { airline: 'LATAM', duration_min: 115 } },
        { from: 0, to: 3, properties: { airline: 'AZUL',  duration_min: 65 } },
    ],
};

const bytes = serialize(airports, routes, {
    writeColumnIndex: { features: ['iata', 'city', 'intl'], links: ['airline'] },
});
const fr = await FlatRecord.open(bytes);

// "Tap GRU → fly somewhere international"
const gru = await fr.featureIndexBy({ column: 'iata', value: 'GRU' });
for await (const l of fr.outgoingLinksOf(gru)) {
    const dest = await fr.getFeature(l.to);
    if (dest.properties.intl) {
        console.log(`${dest.properties.iata} (${l.properties.duration_min} min)`);
    }
}

// Nearest airport to a point
for await (const r of fr.nearestFeatures([-46.5, -23.5], { limit: 1, unit: 'kilometers' })) {
    console.log(`${r.feature.properties.iata} at ${r.distance.toFixed(0)} km`);
}
```

### Dependency graph (graph mode, no geometry)

```typescript
const deps: Row[] = [
    { pkg: 'app',     version: '1.0.0', stars: 1024 },
    { pkg: 'auth',    version: '2.3.1', stars:  512 },
    { pkg: 'db',      version: '4.0.0', stars: 2048 },
    { pkg: 'cache',   version: '1.5.2', stars:  256 },
    { pkg: 'logger',  version: '0.9.0', stars:  128 },
];
const adjacency = {
    links: [
        { from: 0, to: 1, properties: { optional: false } },
        { from: 0, to: 2, properties: { optional: false } },
        { from: 1, to: 2, properties: { optional: false } },
        { from: 2, to: 3, properties: { optional: true  } },
        { from: 2, to: 4, properties: { optional: false } },
    ],
};

const fr = await FlatRecord.open(
    serialize(deps, adjacency, { writeColumnIndex: { features: ['pkg', 'stars'], links: ['optional'] } }),
);

// In-degree to spot popular dependencies
for (let i = 0; i < fr.featuresCount; i++) {
    const pkg = (await fr.getFeature(i)).properties.pkg;
    console.log(`${pkg}: ${await fr.inDegreeOf(i)} dependents, ${await fr.outDegreeOf(i)} deps`);
}

// Avoid optional links
const strict = await fr.shortestPath(0, 3, {
    weight: (props) => (props.optional ? Infinity : 1),
});
```

### Pure tabular table (no geometry, no links)

```typescript
const events: Row[] = [
    { ts: 1700000000000, level: 'info',  message: 'startup' },
    { ts: 1700000005000, level: 'warn',  message: 'cache miss' },
    { ts: 1700000010000, level: 'error', message: 'db connection failed' },
];

const bytes = serialize(events, undefined, {
    writeColumnIndex: { features: ['ts', 'level', 'message'] },
    timestamp: 'now',
});
const fr = await FlatRecord.open(bytes);

// Range query
for await (const e of fr.findFeaturesByValue('ts', { gte: 1700000005000 })) {
    console.log(e.properties);
}

// Text search
for await (const hit of fr.findFeaturesByText('message', 'db')) {
    console.log(hit.feature.properties);
}
```

## Browser usage

```typescript
// ESM via unpkg or jsdelivr
import { serialize, deserialize, FlatRecord, byteReaderFromUrl }
    from 'https://unpkg.com/flatrecord/dist/flatrecord-geojson.esm.min.js';

const fr = await FlatRecord.open(byteReaderFromUrl('/data/network.frb'));
for await (const f of fr.featuresInBbox(rect)) { /* … */ }
```

The dist bundles target `>2%, not dead, not ie 11`. UMD versions are available alongside ESM if you need globals.
