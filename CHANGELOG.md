# Changelog

All user-facing changes to the `flatrecord` npm package. Format
follows [Keep a Changelog](https://keepachangelog.com/). Wire-format
changes are tracked separately in
[`doc/format-changelog.md`](doc/format-changelog.md).

## 1.0.0 — Initial release

FlatRecord is a single binary container that adapts to four shapes of
data — tables, geospatial features, abstract graphs, or geospatial
graphs — with the same TypeScript API. The mode is inferred from the
data; there's no flag to set.

### File format (frb v1)

- Magic bytes `frb\x01frb\x00` (`0x66 0x72 0x62 0x01 0x66 0x72 0x62 0x00`).
- Flatbuffer header carrying a directory of `(offset, length)` for
  every payload block: feature spatial R-tree, features payload,
  per-column property indices on features, link spatial R-tree, link
  adjacency CSR, link reverse adjacency CSR, link property indices,
  links payload.
- 4-byte CRC32 (IEEE 802.3) slot immediately after the header bytes.
  `0` = "writer didn't compute"; otherwise readers verify and fail
  fast on mismatch.
- See [`doc/format-spec.md`](doc/format-spec.md) for the full wire
  layout and [`doc/format-changelog.md`](doc/format-changelog.md) for
  the contract documenting how this format will evolve.

### Public API surface

```typescript
import {
    serialize, deserialize, FlatRecord,
    byteReaderFromUint8Array, byteReaderFromUrl,
    type Row, type Link, type LinkInput, type LinkProperties,
    type AdjacencyList, type AdjacencyListInput,
    type DeserializeResult, type FlatRecordMeta, type FlatRecordMode,
    type SerializeOptions, type SchemaSpec, type ColumnSpec,
    type ShortestPathOptions, type ShortestPathResult,
    type LinkWeightFn, type HeuristicFn,
    type NearestFeaturesOptions, type DistanceUnit,
    type FlatRecordInspect, type FlatRecordBlockInfo,
    type ByteReader, type UrlReaderOptions,
} from 'flatrecord/geojson';
```

- **`serialize(input, adjacency?, options?)`** — accepts a GeoJSON
  `FeatureCollection` (geo / geograph) or a plain `Row[]` (table /
  graph). Modes are inferred from the data.
- **`deserialize(bytes, metaFn?)`** — discriminated result by `mode`:
  `{ features, adjacencyList }` on geo / geograph; `{ rows,
  adjacencyList }` on table / graph.
- **`FlatRecord`** class — random-access reader. Open once, reuse for
  every query. All reads are lazy and cached per instance; `preload()`
  pulls the whole file in one round trip when needed.

### Feature methods on `FlatRecord`

- `getFeature(i)` / `getFeatures([…])` — single / bulk fetch with
  byte-range coalescing.
- `features()` — async iterator in storage order.
- `featuresInBbox(rect)` — packed Hilbert R-tree spatial filter.
- `nearestFeatures(point, { unit, maxDistance, limit })` — best-first
  KNN traversal. Default `limit: 100`, units in `meters` /
  `kilometers` / `nautical_miles`.

### Link methods on `FlatRecord`

- `getLink(i)` / `getLinks([…])` — random access + bulk fetch.
- `outgoingLinksOf(v)` / `incomingLinksOf(v)` — O(deg) via forward /
  reverse CSR.
- `outDegreeOf(v)` / `inDegreeOf(v)`.
- `linkIndexBetween(from, to)` — find a specific edge by endpoints.
- `allLinks()` — iterate every link.
- `linksInBbox(rect)` — spatial filter over link bboxes.

### Property indices

- Text (NFKD-normalised, tiered: A / B / C by match consecutiveness +
  order), numeric (range), boolean (equality).
- `findFeaturesByText(column, query, opts?)`,
  `findFeaturesByValue(column, predicate, opts?)`,
  `findLinksByText(...)`, `findLinksByValue(...)`.
- `featureIndexBy({ column, value })` — resolves a single feature for
  use with `shortestPath` / `getFeature` / etc.

### Shortest path

- `shortestPath(from, to, options?)` — A* with haversine heuristic
  on geographic files; Dijkstra on `graph` files (no coordinates).
- Endpoints accept either a numeric index or `{ column, value }`
  lookup descriptor.
- `weight(properties, distance) → number`, properties first.
  Defaults: `(_, d) => d` on geo / geograph; `() => 1` (hop count)
  on graph.

### Diagnostics

- `fr.inspect()` — synchronous structured snapshot of the directory:
  block offsets, lengths, percentages, indices present, CRC status.
- Header `timestamp` field — Unix-time-ms via
  `serialize(…, { timestamp: 'now' | number })`. Exposed as
  `fr.header.timestamp: number | null`.

### Validation

- Explicit schema via `serialize(…, { schema: SchemaSpec })` — catches
  type mismatches, missing required, non-nullable nulls at write time.
- Header CRC32 (enabled by default) catches corruption at `open()`.

### Tested

~4 000 tests across 14 spec files covering:
- 128-permutation exhaustive matrix of writer flags (geographic mode)
- 64-permutation matrix for tabular files (no geometry)
- Cold vs preload-warm symmetry
- Pinned wire-format byte layouts (fixtures + offsets)
- KNN, bulk fetch, schema validation, CRC corruption, scale (5 000-row
  text-search benchmark)
