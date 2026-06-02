# Changelog

All user-facing changes to the `flatrecord` npm package. Format
follows [Keep a Changelog](https://keepachangelog.com/). Wire-format
changes are tracked separately in
[`doc/format-changelog.md`](doc/format-changelog.md).

## 1.0.2

Memory feature + packaging fix. A preloaded reader can now release its
source buffer entirely (keeping only the decoded caches + compact
indices), which matters when many datasets are held resident at once.
Subpath imports (`flatrecord/geojson`, `flatrecord/generic`) now also
resolve under bundlers that don't read package `exports`.

### Added

- **`preload({ detach: true })`** — copies the retained index/links
  byte ranges out of the source buffer (instead of holding `subarray`
  views over it) and releases the underlying `ByteReader`, so the
  whole-file buffer is garbage-collected. Only the decoded feature
  cache and the small index copies stay resident; every query is still
  served from those caches. The new `PreloadOptions` type is exported.
  Default (`preload()`) is unchanged — zero-copy views, buffer retained.
- **Classic-resolver subpath entry points** — `geojson.js` /
  `geojson.d.ts` and `generic.js` / `generic.d.ts` at the package root
  re-export the built modules. Bundlers that follow `exports` are
  unaffected (they keep using the `exports` map); resolvers that don't
  (e.g. Metro with `unstable_enablePackageExports` off) now resolve
  `flatrecord/geojson` with no per-app configuration.

### Changed

- `getLinks([…])` (bulk) is served from the resident links section
  after `preload()` instead of issuing a reader round-trip, so it works
  on a detached instance (matching the existing `getLink(i)` behaviour).
- `release()` / `releaseFeatures()` / `releaseLinks()` /
  `releaseIndices()` / `releasePropertyIndices()` now throw on a
  detached instance: a detached reader has no byte source to rebuild a
  cleared cache from, so clearing one would leave it silently broken.
  Drop all references to the instance to free its memory, and re-open
  the file if you need it again.

### Fixed

- `fr.header.envelope` was a `Float64Array` **view** over the header
  bytes, which kept the whole source buffer alive — defeating
  `preload({ detach: true })` and needlessly retaining a slice of the
  source on the cold-reader path. It is now copied out, so `header`
  never pins the source buffer. Values are unchanged.

## 1.0.1

Fix + feature: identity strings (`name`, `title`, `description`,
`metadata`) were declared on the writer's internal spec but never
threaded through `SerializeOptions` or actually written into the
header. The hardcoded `name: "L1"` is removed; all four fields are
now optional `serialize` options and surface on `fr.header` as
`string | null`.

### Added

- `SerializeOptions.{name, title, description, metadata}` — write any
  subset of the dataset identity strings. Each unset field is `null`
  on the reader.
- `HeaderMeta.name` — short identifier surfaced on `fr.header.name`
  (was previously only readable via raw flatbuffer access).
- New pinned fixture `test/data/with-metadata.frb` populates every
  identity field + a frozen timestamp, with dedicated round-trip
  tests in `fixtures.spec.ts`.

### Changed

- The default value of `header.name` is no longer the hardcoded
  string `"L1"` — files written by 1.0.0 (which always wrote `"L1"`)
  still open fine; the writer just no longer emits `"L1"` when no
  `name` is supplied.

### Fixture sizes

All fixtures shrink by 8 bytes (no more `"L1"` literal in the
header). `minimal.frb`: 260 → 244 B, `table-users.frb`: 1096 → 1088,
`graph-deps.frb`: 1625 → 1617.

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
