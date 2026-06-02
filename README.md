# FlatRecord

[![npm](https://img.shields.io/npm/v/flatrecord.svg)](https://www.npmjs.com/package/flatrecord)
[![npm downloads](https://img.shields.io/npm/dm/flatrecord.svg)](https://www.npmjs.com/package/flatrecord)
[![types](https://img.shields.io/npm/types/flatrecord.svg)](https://www.npmjs.com/package/flatrecord)
[![bundle size](https://img.shields.io/bundlephobia/minzip/flatrecord)](https://bundlephobia.com/package/flatrecord)
[![license](https://img.shields.io/npm/l/flatrecord.svg)](LICENSE)

A performant binary encoding for **structured records** — tables, geospatial features, connected graphs, or any combination — in a single file format with a streaming-friendly layout.

## Why FlatRecord?

You have **structured records you want to query efficiently from a single file**. Maybe they're tabular (50 000 customers); maybe they have geometry (50 000 airports); maybe they're connected (50 000 airports and the routes between them); maybe all of the above. You don't want to ship four different file formats — or pay the memory cost of loading the whole dataset just to read one record.

FlatRecord packages all of that into a single binary file with a **directory in the header**. Every payload block — features, links, spatial indices, property indices — is located by an absolute `(offset, length)` pair stored in the header. Readers open the file with one range request and then fetch only the bytes they actually need, even over HTTP. A 50 k-feature file opens in well under 100 ms locally.

The format adapts to your data — there is no "mode" flag you set. Pass an array of rows and you get a tabular file; pass features with geometry and you get a spatial file; add `links` and you get a graph. Every applicable index is built by default; the ones that don't apply are silently skipped.

| Mode | Geometry? | Links? | Typical use |
|---|---|---|---|
| `table` | no | no | analytics records, queryable by text/number/boolean |
| `geo` | yes | no | GeoJSON-style features (drop-in FlatGeobuf replacement) |
| `graph` | no | yes | abstract networks (dependency graphs, taxonomies) |
| `geograph` | yes | yes | road networks, transit, power grids |

## Table of contents

- [Installation](#installation)
- [Quick start (`geograph`)](#quick-start-geograph)
- [Mode-by-mode examples](#mode-by-mode-examples)
  - [`table` — pure tabular records](#table--pure-tabular-records)
  - [`geo` — geospatial features](#geo--geospatial-features)
  - [`graph` — abstract networks](#graph--abstract-networks)
  - [`geograph` — geospatial graphs](#geograph--geospatial-graphs)
- [What you get](#what-you-get)
- [Cross-cutting patterns](#cross-cutting-patterns)
  - [Text / range search by property](#text--range-search-by-property)
  - [Find by code → shortest path](#find-by-code--shortest-path)
  - [Remote files over HTTP](#remote-files-over-http)
- [Where to look next](#where-to-look-next)
- [Design at a glance](#design-at-a-glance)
- [License](#license)
- [Credits](#credits)

## Installation

```bash
npm install flatrecord
```

ESM only. Supports Node ≥ 18, modern browsers and React Native.

## Quick start (`geograph`)

```typescript
import { FlatRecord, serialize, deserialize } from 'flatrecord/geojson';

// Three Brazilian capitals with road connections between them.
const geojson = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.63, -23.55] }, properties: { name: 'São Paulo' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.17, -22.91] }, properties: { name: 'Rio'       } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.93, -15.78] }, properties: { name: 'Brasília'  } },
    ],
};
const adjacency = {
    links: [
        { from: 0, to: 1, properties: { road: 'BR-116' } },
        { from: 0, to: 2, properties: { road: 'BR-050' } },
    ],
};

const bytes = serialize(geojson, adjacency);   // every applicable index on, WGS84

const fr = await FlatRecord.open(bytes);
console.log(fr.mode);   // 'geograph'

// Walk outgoing links of São Paulo.
for await (const link of fr.outgoingLinksOf(0)) {
    console.log(`SP → ${link.to}`, link.properties);
}

// Shortest path from Brasília to Rio (A* with haversine).
const path = await fr.shortestPath(2, 1);
console.log(path?.cost, path?.features.map(f => f.properties.name));

// Or: load everything at once.
const { features, adjacencyList } = await deserialize(bytes);
```

## Mode-by-mode examples

### `table` — pure tabular records

No geometry, no links. Pass a plain array of objects directly — no GeoJSON envelope needed. Use indexed columns for text / range / boolean queries.

```typescript
import { FlatRecord, serialize, deserialize, type Row } from 'flatrecord/geojson';

const users: Row[] = [
    { id: 'u1', name: 'Alice', age: 30, vip: true  },
    { id: 'u2', name: 'Bob',   age: 25, vip: false },
    { id: 'u3', name: 'Carol', age: 45, vip: true  },
];

const bytes = serialize(users, undefined, {
    writeColumnIndex: { features: ['id', 'name', 'age', 'vip'] },
});

// `deserialize` is symmetric — table input ⇒ table output.
const result = await deserialize(bytes);
if (result.mode === 'table' || result.mode === 'graph') {
    console.log(result.rows);   // [{ id: 'u1', name: 'Alice', … }, …]
}

// Or query without loading everything:
const fr = await FlatRecord.open(bytes);
fr.mode;          // 'table'
fr.hasGeometry;   // false
fr.hasLinks;      // false

// Find by text — tier-ranked.
for await (const hit of fr.findFeaturesByText('name', 'alice')) {
    console.log(hit.tier, hit.feature.properties);   // 'A', { id: 'u1', name: 'Alice', … }
}

// Numeric range, boolean equality.
for await (const f of fr.findFeaturesByValue('age', { gte: 30 })) { /* … */ }
for await (const f of fr.findFeaturesByValue('vip', { eq: true })) { /* … */ }

// Look up the storage index of a single record.
const idx = await fr.featureIndexBy({ column: 'id', value: 'u2' });   // 1
```

### `geo` — geospatial features

Features with geometry but no links. Drop-in replacement for FlatGeobuf-style files: spatial R-tree for bbox queries.

```typescript
import { FlatRecord, serialize } from 'flatrecord/geojson';

const airports = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.47, -23.43] }, properties: { iata: 'GRU', name: 'Guarulhos'  } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.24, -22.81] }, properties: { iata: 'GIG', name: 'Galeão'     } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.91, -15.87] }, properties: { iata: 'BSB', name: 'Brasília'   } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.66, -23.63] }, properties: { iata: 'CGH', name: 'Congonhas'  } },
    ],
};

const bytes = serialize(airports, undefined, {
    writeColumnIndex: { features: ['iata', 'name'] },
});

const fr = await FlatRecord.open(bytes);
fr.mode;   // 'geo'

// Spatial filter: every airport inside a São Paulo bbox.
const sp = { minX: -47.0, minY: -24.0, maxX: -46.0, maxY: -23.0 };
for await (const f of fr.featuresInBbox(sp)) {
    console.log(f.properties.iata, f.properties.name);
}

// Text search composes with spatial.
for await (const hit of fr.findFeaturesByText('name', 'galeao')) {
    console.log(hit.feature.properties.iata);   // 'GIG'
}
```

### `graph` — abstract networks

Records connected by links, no geometry. Useful for dependency graphs, taxonomies, social networks — anything where coordinates don't matter but relationships do. `shortestPath` works on link properties via custom weight.

```typescript
import { FlatRecord, serialize, type Row } from 'flatrecord/geojson';

const packages: Row[] = [
    { pkg: 'app',     version: '1.0.0' },
    { pkg: 'auth',    version: '2.3.1' },
    { pkg: 'db',      version: '4.0.0' },
    { pkg: 'cache',   version: '1.5.2' },
    { pkg: 'logger',  version: '0.9.0' },
];
const adjacency = {
    links: [
        { from: 0, to: 1, properties: { kind: 'runtime', optional: false } },
        { from: 0, to: 2, properties: { kind: 'runtime', optional: false } },
        { from: 0, to: 4, properties: { kind: 'dev',     optional: true  } },
        { from: 1, to: 2, properties: { kind: 'runtime', optional: false } },
        { from: 2, to: 3, properties: { kind: 'runtime', optional: true  } },
        { from: 2, to: 4, properties: { kind: 'runtime', optional: false } },
    ],
};

const bytes = serialize(packages, adjacency, {
    writeColumnIndex: { features: ['pkg'], links: ['kind', 'optional'] },
});

const fr = await FlatRecord.open(bytes);
fr.mode;   // 'graph'

// Neighbours (O(deg) via the adjacency CSR).
for await (const link of fr.outgoingLinksOf(0)) {
    console.log(link.to, link.properties.kind);
}

// Filter links by property.
for await (const l of fr.findLinksByValue('optional', { eq: true })) {
    console.log(`${l.from} → ${l.to} (optional)`);
}

// Shortest path. On `graph` mode the default weight is `() => 1`
// (hop count) and the default heuristic is null (Dijkstra) — no
// custom options needed.
const path = await fr.shortestPath(
    { column: 'pkg', value: 'app' },
    { column: 'pkg', value: 'cache' },
);
console.log(path?.features.map(f => f.properties.pkg));   // ['app', 'db', 'cache']
console.log(path?.cost);   // 2 (two hops)

// Weight by dependency kind: avoid optional links unless necessary.
const strict = await fr.shortestPath(
    { column: 'pkg', value: 'app' },
    { column: 'pkg', value: 'cache' },
    { weight: (props) => (props.optional ? 100 : 1) },
);
```

### `geograph` — geospatial graphs

Features with geometry **and** links — the full road-network, transit, or power-grid story. Spatial queries, neighbour lookup, A* with haversine, and property indices on both sides, all from the same file.

```typescript
import { FlatRecord, serialize } from 'flatrecord/geojson';

const cities = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-46.63, -23.55] }, properties: { name: 'São Paulo',     icao: 'SBSP' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-43.17, -22.91] }, properties: { name: 'Rio de Janeiro', icao: 'SBRJ' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-47.93, -15.78] }, properties: { name: 'Brasília',      icao: 'SBBR' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-49.27, -16.68] }, properties: { name: 'Rio Preto',     icao: 'SBSR' } },
    ],
};
const roads = {
    links: [
        { from: 0, to: 1, properties: { road: 'BR-116', km: 429 } },
        { from: 0, to: 2, properties: { road: 'BR-050', km: 1015 } },
        { from: 0, to: 3, properties: { road: 'BR-153', km: 442 } },
        // Optional LineString: explicit path between vertices.
        { from: 2, to: 3, geometry: { type: 'LineString', coordinates: [[-47.93, -15.78], [-48.5, -16.3], [-49.27, -16.68]] }, properties: { road: 'BR-070', km: 580 } },
    ],
};

const bytes = serialize(cities, roads, {
    writeColumnIndex: { features: ['icao'], links: ['road'] },
});

const fr = await FlatRecord.open(bytes);
fr.mode;   // 'geograph'

// Spatial filter on features.
for await (const c of fr.featuresInBbox({ minX: -50, minY: -20, maxX: -45, maxY: -10 })) {
    console.log(c.properties.name);
}

// Spatial filter on links (link bbox unions endpoints + LineString geometry).
for await (const l of fr.linksInBbox({ minX: -50, minY: -17, maxX: -47, maxY: -15 })) {
    console.log(l.properties.road);
}

// A* with haversine. Coordinates assumed [lon, lat] in degrees.
const path = await fr.shortestPath(0, 3);   // São Paulo → Rio Preto
console.log(`${path?.cost.toFixed(0)} m through ${path?.features.length} cities`);

// Skip the "find by code → index → call" trip — descriptors resolve via the text index.
const fast = await fr.shortestPath(
    { column: 'icao', value: 'SBSP' },
    { column: 'icao', value: 'SBSR' },
);
```

## What you get

Six optional indices, all enabled by default when applicable:

| Index | What it unlocks | Modes |
| --- | --- | --- |
| Feature spatial R-tree | `featuresInBbox(rect)`, `nearestFeatures(point)` | `geo`, `geograph` |
| Adjacency CSR | `outgoingLinksOf(v)`, `outDegreeOf(v)`, `linkIndexBetween(from, to)`, `shortestPath()` | `graph`, `geograph` |
| Reverse adjacency CSR | `incomingLinksOf(v)`, `inDegreeOf(v)` | `graph`, `geograph` |
| Link spatial R-tree | `linksInBbox(rect)` | `graph`, `geograph` |
| Per-column property index — features | `findFeaturesByText/Value`, `featureIndexBy({ column, value })` | all four |
| Per-column property index — links | `findLinksByText/Value` | `graph`, `geograph` |

A reader opens the file with **one range read** (the header carries a directory of every block's offset and length, plus a CRC32 over the header for early-failure detection on corrupted files) and then fetches only the bytes it actually needs — even over HTTP. A reader that wants the whole dataset in memory calls `preload()` and pays a single round trip.

When many datasets are kept resident at once, `preload({ detach: true })` copies the small index/links ranges out of the source buffer and releases the byte source, so the whole-file buffer is garbage-collected — leaving only the decoded feature cache and the compact indices in memory. Every query is still served from those caches; the trade-off is that a detached instance can no longer fetch uncached bytes (the cache-clearing `release*()` methods throw, and re-reading requires re-opening the file).

For bulk operations, `getFeatures([…indices])` / `getLinks([…indices])` coalesce adjacent byte ranges into single reads — important on remote files where N round-trips would otherwise dominate. `fr.inspect()` returns a structured snapshot of the directory + per-block sizes for diagnostics.

## Cross-cutting patterns

These work in every mode that supports them.

### Text / range search by property

Declare which columns to index at write time, then query without scanning.

```typescript
const bytes = serialize(records, adjacency, {
    writeColumnIndex: { features: ['name', 'code', 'elev_ft'], links: ['weight'] },
});
const fr = await FlatRecord.open(bytes);

// Tier-ranked text — 'A' (consecutive in order) > 'B' (in order, gaps) > 'C' (any order).
for await (const hit of fr.findFeaturesByText('name', 'rio preto')) {
    console.log(hit.tier, hit.feature.properties.name);
}

// Numeric range, boolean equality.
for await (const f of fr.findFeaturesByValue('elev_ft', { gte: 1000, lt: 5000 })) { /* … */ }
```

### Find by code → shortest path

```typescript
const path = await fr.shortestPath(
    { column: 'icao', value: 'SBSP' },
    { column: 'icao', value: 'SBSR' },
);
```

Resolves both endpoints via the `icao` text index, then runs A* with the default haversine heuristic on `geograph` files. On `graph` files (no geometry) the same call defaults to hop-count Dijkstra — supply a custom `weight` to optimize anything else.

### Remote files over HTTP

```typescript
import { FlatRecord, byteReaderFromUrl } from 'flatrecord/geojson';

const fr = await FlatRecord.open(byteReaderFromUrl('https://example.com/network.frb'));
const v0 = await fr.getFeature(0);                         // one Range request
for await (const f of fr.featuresInBbox(rect)) { /* … */ } // R-tree walk over Range requests
```

The server must honour byte-range requests (HTTP 206). Every method works lazily; call `await fr.preload()` to fetch the whole file in a single GET and serve every subsequent query from memory.

## Where to look next

| | |
| --- | --- |
| **Cookbook** | [`doc/usage-examples.md`](doc/usage-examples.md) — recipes for the less-common cases (every property type, custom byte sources, integration with graph libs, …) |
| **API reference** | [`doc/api-reference.md`](doc/api-reference.md) — every public symbol, every option, every method signature |
| **Binary format** | [`doc/format-spec.md`](doc/format-spec.md) — wire layout, header schema, block formats |
| **Format changelog** | [`doc/format-changelog.md`](doc/format-changelog.md) — every wire-format change across versions |
| **Package changelog** | [`CHANGELOG.md`](CHANGELOG.md) — package-level changes and API evolution |

## Design at a glance

- **Mode is inferred, not configured.** Writers emit the data they have; the file's mode is whatever fits.
- **Directory in the header.** The flatbuffer Header carries `(offset, length)` for every payload block. `open()` is one range read; every other read is targeted.
- **Symmetric I/O.** `serialize(rows)` ↔ `deserialize` returns `{ rows }`; `serialize(geojson)` ↔ `{ features }`. The result type is discriminated by `mode`.
- **Forward-compatible.** Adding new directory fields doesn't break existing readers (FlatBuffers semantics).
- **Links are directed.** No self-loops. For bidirectional connections, emit two links.
- **Link geometry is optional.** A link with no `LineString` is treated as a straight line between its endpoints' features.

## License

BSD-2-Clause. See [`LICENSE`](LICENSE) for the full text and a list of
copyright holders.

The packed Hilbert R-tree implementation in `src/ts/packedrtree*.ts`
is derived from [`flatbush`](https://github.com/mourner/flatbush) by
Vladimir Agafonkin, distributed under the ISC License. See
[`LICENSE-flatbush`](LICENSE-flatbush) for its full text.

## Credits

The feature record format, the packed Hilbert R-tree layout, and the
column-indexed property encoding are inherited from
[FlatGeobuf](https://github.com/flatgeobuf/flatgeobuf) by Björn
Harrtell — see [`LICENSE`](LICENSE) for attribution.
