# FlatRecord — API reference

Detailed reference for every public symbol. The umbrella entry point is `flatrecord/geojson`; everything described here is re-exported from the root `flatrecord` barrel as well.

For a task-oriented overview see [usage-examples.md](usage-examples.md). For the binary format see [format-spec.md](format-spec.md).

## Public surface

| Symbol | Kind | One-liner |
| --- | --- | --- |
| `serialize(geojson \| rows, adjacencyList?, options?)` | function | Encode a GeoJSON `FeatureCollection` **or** a plain `Row[]` (+ optional adjacency) to FlatRecord bytes. |
| `deserialize(bytes, metaFn?)` | async function | Decode every feature + link from an in-memory buffer; result is discriminated by `mode`. |
| `FlatRecord` | class | Random-access reader for one source (in-memory or remote). |
| `ByteReader` | interface | Minimal abstraction for "give me bytes at offset/length". |
| `byteReaderFromUint8Array(bytes)` | factory | Wrap an in-memory buffer. |
| `byteReaderFromUrl(url, opts?)` | factory | Wrap an HTTP URL (Range requests + readAll). |
| `SerializeOptions` / `PropertyIndexSpec` / `SchemaSpec` / `ColumnSpec` | types | Writer flags + optional explicit schema. |
| `DistanceUnit` / `NearestFeaturesOptions` | types | Options for `nearestFeatures`. |
| `PreloadOptions` | type | Options for `preload` (`{ detach }` releases the source buffer). |
| `FlatRecordInspect` / `FlatRecordBlockInfo` | types | Structured snapshot returned by `fr.inspect()`. |
| `ShortestPathOptions` / `ShortestPathResult` | types | Pathfinding I/O. |
| `LinkWeightFn` / `HeuristicFn` | types | Pluggable cost/heuristic. |
| `Link` / `LinkInput` / `LinkProperties` | types | Link record shape. |
| `Row` | type | `Record<string, unknown>` — a tabular row. |
| `AdjacencyList` / `AdjacencyListInput` | types | `{ links: Link[] }` / `{ links: LinkInput[] }`. |
| `DeserializeResult<T>` | type | Discriminated by `mode`: `{ mode: 'geo' \| 'geograph', features, adjacencyList }` or `{ mode: 'table' \| 'graph', rows, adjacencyList }`. |
| `FlatRecordMeta` / `FlatRecordMetaFn` / `FlatRecordMode` | types | Metadata + mode enum. |
| `TextHit<T>` / `FeatureLookup` | types | Tier-ranked text-query result; `{ column, value }` descriptor. |
| `HeaderMeta` / `BlockLocation` / `ColumnIndexLocation` | types | Raw header / directory, exposed via `FlatRecord.header`. |
| `UrlReaderOptions` | type | Options for `byteReaderFromUrl`. |

## Types

```typescript
import type { LineString } from 'geojson';

interface LinkInput {
    from: number;
    to: number;
    geometry?: LineString | null;
    properties?: LinkProperties;
}

interface Link {
    from: number;
    to: number;
    geometry: LineString | null;
    properties: LinkProperties;
}

interface LinkProperties {
    [key: string]: boolean | number | string | object | Uint8Array | null | undefined;
}

interface AdjacencyListInput { links: LinkInput[]; }
interface AdjacencyList       { links: Link[]; }

type Row = Record<string, unknown>;

// Discriminated by `mode`. `features` is present on files with
// geometry; `rows` on tabular files (no per-feature geometry).
type DeserializeResult<T> =
    | { mode: 'geo' | 'geograph'; features: T[]; adjacencyList: AdjacencyList }
    | { mode: 'table' | 'graph'; rows: Row[]; adjacencyList: AdjacencyList };

type FlatRecordMode = 'table' | 'geo' | 'graph' | 'geograph';

interface BlockLocation       { offset: number; length: number; }
interface ColumnIndexLocation { column: string; offset: number; length: number; }

interface HeaderMeta {
    geometryType: GeometryType;
    columns: ColumnMeta[] | null;
    envelope: Float64Array | null;
    featuresCount: number;
    indexNodeSize: number;
    crs: CrsMeta | null;
    title: string | null;
    description: string | null;
    metadata: string | null;
    // Directory — absolute byte offsets, length === 0 means absent.
    featureSpatialIndex: BlockLocation;
    featureColumnIndices: ColumnIndexLocation[];
    featuresBlock: BlockLocation;
    linksCount: number;
    linkColumns: ColumnMeta[] | null;
    linkSpatialIndex: BlockLocation;
    linkColumnIndices: ColumnIndexLocation[];
    linkAdjacencyIndex: BlockLocation;
    linksBlock: BlockLocation;
}

interface FlatRecordMeta extends HeaderMeta {
    mode: FlatRecordMode;
    hasGeometry: boolean;
    hasLinks: boolean;
}

type FlatRecordMetaFn = (meta: FlatRecordMeta) => void;

interface FeatureLookup {
    column: string;
    value: string | number | boolean;
}

type TextHit<T, Key extends 'feature' | 'link' = 'feature'> = Key extends 'link'
    ? { link: T; tier: 'A' | 'B' | 'C'; index: number }
    : { feature: T; tier: 'A' | 'B' | 'C'; index: number };
```

## `serialize`

```typescript
// Two overloads — the second is sugar for the first when there's no
// geometry. Either form accepts the same `adjacencyList` + `options`.
function serialize(
    geojson: GeoJsonFeatureCollection,
    adjacencyList?: AdjacencyListInput,
    options?: SerializeOptions,
): Uint8Array;
function serialize(
    rows: Row[],
    adjacencyList?: AdjacencyListInput,
    options?: SerializeOptions,
): Uint8Array;

interface SerializeOptions {
    crsCode?: number;                          // EPSG code (default: 4326)
    writeSpatialIndex?: boolean;               // feature R-tree (default: true)
    writeAdjacencyIndex?: boolean;             // link CSR (default: true)
    writeReverseAdjacencyIndex?: boolean;      // reverse CSR (default: true)
    writeLinkSpatialIndex?: boolean;           // link R-tree (default: true)
    writeColumnIndex?: PropertyIndexSpec;      // property indices (default: none)
    writeHeaderCrc?: boolean;                  // CRC32 over header (default: true)
    schema?: SchemaSpec;                       // explicit schema validation (default: infer)
    timestamp?: number | 'now';                // header timestamp (default: not set)
}

interface PropertyIndexSpec {
    features?: string[];
    links?: string[];
}

interface SchemaSpec {
    features?: Record<string, ColumnSpec>;
    links?: Record<string, ColumnSpec>;
}

interface ColumnSpec {
    type:
        | 'Bool' | 'Byte' | 'UByte' | 'Short' | 'UShort'
        | 'Int' | 'UInt' | 'Long' | 'ULong'
        | 'Float' | 'Double'
        | 'String' | 'Json' | 'DateTime' | 'Binary';
    required?: boolean;        // throw if missing from any record
    nullable?: boolean;        // default: true; false ⇒ null/undefined throws
}
```

- **Returns:** a new `Uint8Array` containing the full file.
- **Throws:** invalid `link.from` / `link.to` (out of range or self-loops); non-LineString link geometry; LineStrings with fewer than 2 coordinates; (with explicit `schema`) unknown columns, type mismatches, missing required fields, null on non-nullable.
- **Side effects:** none. Input collections are not mutated.

### Index trade-offs

| Option | Cost | Unlocks |
| --- | --- | --- |
| `writeSpatialIndex` | reorders features along the Hilbert curve; auto-remaps `link.from` / `link.to` | `fr.featuresInBbox(rect)`, `fr.nearestFeatures(point)`, O(1) `fr.getFeature(i)` |
| `writeAdjacencyIndex` | sorts links by `from`; writes an `[N+1]` offsets table | `fr.outgoingLinksOf(v)`, `fr.outDegreeOf(v)`, `fr.linkIndexBetween(f,t)`, `fr.shortestPath` |
| `writeReverseAdjacencyIndex` | builds a CSR sorted by `to` + per-link byte-offset array | `fr.incomingLinksOf(v)`, `fr.inDegreeOf(v)` |
| `writeLinkSpatialIndex` | builds a packed Hilbert R-tree over link bboxes | `fr.linksInBbox(rect)` |
| `writeColumnIndex.features[c]` | text / numeric / boolean index over column `c` | `fr.findFeaturesByText/Value('${c}', …)`, `fr.featureIndexBy({ column: '${c}', value })` |
| `writeColumnIndex.links[c]` | same, for links | `fr.findLinksByText/Value('${c}', …)` |
| `writeHeaderCrc` | one extra CRC32 pass over the header bytes (~ms even on huge headers) | early-failure detection on corrupted files in `FlatRecord.open` |
| `schema` | per-record type/required/nullable check before write | deterministic schema + clear write-time error on bad data |
| `timestamp: 'now'` / `number` | 8 bytes in the header | `fr.header.timestamp` (Unix-time-ms, `null` when not set) |

Options that can't apply are silently ignored: `writeAdjacencyIndex` / `writeReverseAdjacencyIndex` / `writeLinkSpatialIndex` / `writeColumnIndex.links` when no adjacency is supplied; `writeSpatialIndex` on `table` / `graph` mode files.

## `deserialize`

```typescript
function deserialize(
    bytes: Uint8Array,
    metaFn?: FlatRecordMetaFn,
): Promise<DeserializeResult<IGeoJsonFeature>>;
```

Full in-memory decode. Use `FlatRecord.open(bytes)` instead for sparse queries or huge files. The optional `metaFn` callback is fired with the parsed `FlatRecordMeta` before features are materialised — useful for early validation or progress UI.

The return shape is discriminated by `mode`. Narrow before accessing the payload:

```typescript
const result = await deserialize(bytes);
if (result.mode === 'geo' || result.mode === 'geograph') {
    // result.features: IGeoJsonFeature[]
} else {
    // result.rows: Row[] — for `table` / `graph` modes
}
// result.adjacencyList.links is always present (empty array on file with no links).
```

## Class `FlatRecord`

Random-access reader. Open one instance per source and reuse it for every query — methods are async, results are cached per instance.

```typescript
class FlatRecord {
    readonly reader: ByteReader;
    readonly header: HeaderMeta;

    get featuresCount(): number;
    get linksCount(): number;
    get hasGeometry(): boolean;
    get hasLinks(): boolean;
    get mode(): FlatRecordMode;
    meta(): FlatRecordMeta;

    static open(source: Uint8Array | ByteReader): Promise<FlatRecord>;

    // Feature access
    getFeature(index: number): Promise<IGeoJsonFeature>;
    getFeatures(indices: ReadonlyArray<number>): Promise<IGeoJsonFeature[]>;  // bulk, coalesced
    features(): AsyncGenerator<IGeoJsonFeature>;
    featuresInBbox(rect: Rect): AsyncGenerator<IGeoJsonFeature>;
    nearestFeatures(
        point: readonly [number, number],
        options?: NearestFeaturesOptions,
    ): AsyncGenerator<{ feature: IGeoJsonFeature; distance: number; index: number }>;
    getFeatureBbox(index: number): Promise<Rect | null>;  // R-tree envelope, no geometry decode

    // Link access
    getLink(storageIdx: number): Promise<Link>;
    getLinks(indices: ReadonlyArray<number>): Promise<Link[]>;                // bulk, coalesced
    outgoingLinksOf(featureIdx: number): AsyncGenerator<Link>;
    incomingLinksOf(featureIdx: number): AsyncGenerator<Link>;
    outDegreeOf(featureIdx: number): Promise<number>;
    inDegreeOf(featureIdx: number): Promise<number>;
    linkIndexBetween(from: number, to: number): Promise<Link | null>;
    allLinks(): AsyncGenerator<Link>;
    linksInBbox(rect: Rect): AsyncGenerator<Link>;

    // Property-index queries
    findFeaturesByText(column: string, query: string, options?: TextQueryOptions):
        AsyncGenerator<TextHit<IGeoJsonFeature>>;
    findFeaturesByValue(column: string, predicate: ValuePredicate, options?: ValueQueryOptions):
        AsyncGenerator<IGeoJsonFeature>;
    findLinksByText(column: string, query: string, options?: TextQueryOptions):
        AsyncGenerator<TextHit<Link, 'link'>>;
    findLinksByValue(column: string, predicate: ValuePredicate, options?: ValueQueryOptions):
        AsyncGenerator<Link>;

    featureIndexBy(lookup: FeatureLookup): Promise<number>;

    toGeoJson(): Promise<DeserializeResult<IGeoJsonFeature>>;

    shortestPath(
        from: number | FeatureLookup,
        to: number | FeatureLookup,
        options?: ShortestPathOptions,
    ): Promise<ShortestPathResult | null>;

    // Diagnostics
    inspect(): FlatRecordInspect;   // directory + sizes + indices snapshot

    // Eager cache warmup
    loadFeatures(options?: { bbox?: boolean }): Promise<IGeoJsonFeature[]>;
    loadLinks(): Promise<void>;
    loadIndices(): Promise<void>;
    loadFeatureColumnIndex(name: string): Promise<PropertyIndex>;
    loadLinkColumnIndex(name: string): Promise<PropertyIndex>;
    loadPropertyIndices(): Promise<void>;
    preload(): Promise<void>;

    // Synchronous cache release
    release(): void;
    releaseFeatures(): void;
    releaseLinks(): void;
    releaseIndices(): void;
    releasePropertyIndices(): void;
}
```

### `FlatRecord.open(source)`

- **`source`**: a `Uint8Array` or any `ByteReader` (HTTP, `fs.read`, mmap, …).
- **I/O budget:** one range read — the header. Carries a directory of absolute offsets that locates every payload block. No feature payload, link data, or index block is touched.
- **Throws:** invalid magic, truncated header.

### Feature methods

| Method | Returns | Requires (writer-side) | Notes |
| --- | --- | --- | --- |
| `getFeature(i)` | `Promise<IGeoJsonFeature>` | nothing | O(1) read with feature R-tree; falls back to a bulk load otherwise. Cached per `i`. |
| `getFeatures([i, j, …])` | `Promise<IGeoJsonFeature[]>` | nothing | Bulk fetch. Coalesces adjacent byte ranges into single reads — important on remote files. Order matches input. |
| `features()` | `AsyncGenerator<IGeoJsonFeature>` | nothing | Yields every feature in storage order. |
| `featuresInBbox(rect)` | `AsyncGenerator<IGeoJsonFeature>` | `writeSpatialIndex: true` + geometry | Spatial filter. Throws on `table` / `graph` files (no geometry). |
| `nearestFeatures(point, opts?)` | `AsyncGenerator<{ feature, distance, index }>` | `writeSpatialIndex: true` + geometry | Best-first KNN over R-tree. See [`nearestFeatures`](#nearestfeatures-point-options) below. |
| `getFeatureBbox(i)` | `Promise<Rect \| null>` | `writeSpatialIndex: true` + geometry | Per-feature bounding box `{ minX, minY, maxX, maxY }`, read straight from the R-tree leaf — **no geometry decode**. `null` when the file has no feature spatial index. Throws on out-of-range `i`. Matches the feature `getFeature(i)` returns. |

### Link methods

| Method | Returns | Requires (writer-side) | Notes |
| --- | --- | --- | --- |
| `getLink(i)` | `Promise<Link>` | links | Random access to a single link by storage index. First call walks the links block to build an offsets table (O(L) once); subsequent calls O(1). |
| `getLinks([i, j, …])` | `Promise<Link[]>` | links | Bulk fetch, coalesced ranges. Order matches input. |
| `outgoingLinksOf(v)` | `AsyncGenerator<Link>` | `writeAdjacencyIndex: true` + links | Yields links whose `from === v`. Per-feature result cached. |
| `incomingLinksOf(v)` | `AsyncGenerator<Link>` | `writeReverseAdjacencyIndex: true` + links | Yields links whose `to === v`. Per-feature result cached. |
| `outDegreeOf(v)` | `Promise<number>` | `writeAdjacencyIndex: true` + links | Count of outgoing links from `v`. |
| `inDegreeOf(v)` | `Promise<number>` | `writeReverseAdjacencyIndex: true` + links | Count of incoming links to `v`. O(1) via reverse CSR. |
| `linkIndexBetween(from, to)` | `Promise<Link \| null>` | `writeAdjacencyIndex: true` + links | Finds the link `from → to` by walking only `from`'s outgoing range. `null` when no such link exists. |
| `allLinks()` | `AsyncGenerator<Link>` | links | Yields every link in storage order. |
| `linksInBbox(rect)` | `AsyncGenerator<Link>` | `writeLinkSpatialIndex: true` + links | Spatial filter. Returns every link with any bbox overlap. |

### `nearestFeatures(point, options?)`

```typescript
interface NearestFeaturesOptions {
    unit?: 'meters' | 'kilometers' | 'nautical_miles';  // default: 'meters'
    maxDistance?: number;     // cap the search radius (in the chosen unit)
    limit?: number;           // cap the result count (default: 100)
}
```

Best-first traversal over the feature R-tree, keyed by minimum
haversine distance from `point` to each node's bounding rectangle.
Yields features in ascending distance, lazily — internal nodes only
expand when popped. Three independent bounds:

- `limit: 5` → stop after 5 results
- `maxDistance: 80` → stop when next-best is farther than 80 units
- `limit: Infinity` → yield every feature in distance order

Default `limit: 100` exists because k-NN without a cap on a huge
dataset is almost always a bug. Pass `Infinity` for no cap. The R-tree
only expands as needed, so an early `break` from the for-await loop
leaves distant blocks untouched.

### `fr.shortestPath(from, to, options?)`

```typescript
interface ShortestPathOptions {
    weight?: LinkWeightFn;
    heuristic?: HeuristicFn | 'haversine' | null;
}

type LinkWeightFn = (properties: LinkProperties, distance: number) => number;
type HeuristicFn  = (feature: IGeoJsonFeature, target: IGeoJsonFeature) => number;

interface ShortestPathResult {
    features: IGeoJsonFeature[];
    links: Link[];
    cost: number;
}
```

- **Requires:** `writeAdjacencyIndex: true` + links.
- **Coordinates:** `[longitude, latitude]` in degrees; geodesic distance via haversine on the WGS84 mean radius.
- **`weight(properties, distance) → number`** — properties come first because they're the common case; `distance` is the precomputed haversine length of the link in metres (always `0` on `graph` mode files). Defaults depend on the file's mode:
  - `geo` / `geograph` (has geometry) → `(_, d) => d`. `distance` is the haversine length of the link in metres (sum over LineString vertices, or straight line between endpoints when the link has no geometry of its own).
  - `graph` (no geometry) → `() => 1`. Without coordinates the haversine distance is always 0; hop count is the canonical default for unweighted graphs. Override with a property-based weight to optimize anything else.
- **`heuristic`** — defaults depend on the file's mode:
  - `'haversine'` (the default keyword on every file) — A* with straight-line distance between feature points. Admissible when `weight(d, …) ≤ d`.
    - On `graph` mode (no geometry) `'haversine'` silently degrades to `null` — there are no coordinates to compute the heuristic from. The search becomes plain Dijkstra.
  - `(feature, target) => number` — custom; must never overestimate the true remaining cost in the same units as `weight`. Trusted as-is even on `graph` mode files (the function may depend on properties only).
  - `null` — plain Dijkstra. Useful on geographic files when you've swapped `weight` away from metres (travel time, monetary cost, etc.) and the default haversine heuristic stops being admissible.
- **Returns:** the path, or `null` when no path exists. When `from === to` returns a one-feature / zero-link result with `cost: 0`.
- **Throws:** out-of-range indices; missing adjacency CSR; `weight` returning NaN, Infinity, or negative.
- **Memory model:** the search state is sparse (`Map`/`Set`), scaling with features visited (not total count). Feature payloads are fetched lazily and cached.

### Cache lifecycle: `load*` / `preload` / `release*`

All read methods populate caches on the way. Eager helpers let you front-load that work or release the memory it occupies. Every method is idempotent.

| Method | Issues I/O | Touches | Use when |
| --- | --- | --- | --- |
| `loadFeatures(opts?)` | 1 bulk read | feature cache | querying most/all features |
| `loadLinks()` | 2 parallel reads | per-feature outgoing-links cache + links-block + adjacency CSR | traversing a meaningful slice of the graph |
| `loadIndices()` | 1 read per R-tree / CSR present | feature + link R-tree byte caches + adjacency CSR | many spatial queries on a remote file |
| `loadFeatureColumnIndex(name)` / `loadLinkColumnIndex(name)` | 1 read | one column's property index | querying only that column |
| `loadPropertyIndices()` | 1 read per declared column (parallel) | every property index | bulk warmup before many `findBy*` queries |
| `preload(options?)` | 1 request (via `readAll`) or 1 range read covering all blocks | everything | small / medium files that fit in memory |
| `release()` / `releaseFeatures()` / `releaseLinks()` / `releaseIndices()` / `releasePropertyIndices()` | no | one cache (or all) | reclaim memory between batches |

`loadFeatures({ bbox: true })` additionally attaches each feature's stored bounding box (`feature.bbox = [minX, minY, maxX, maxY]`, standard GeoJSON) read from the R-tree — no geometry walk. Handy when you keep the properties + envelope in JS but render geometry elsewhere. Throws if the file has no feature spatial index.

> **Caveat for remote sources.** `preload` and the individual `load*` methods transfer essentially the entire file. Use them only when the data fits in memory and you intend to query enough of it that the upfront cost pays off. For multi-gigabyte remote files keep relying on the lazy methods; `loadIndices()` is a useful middle ground (R-trees in memory, payloads still lazy).

#### `preload({ detach })` — drop the source buffer, keep the caches

```typescript
interface PreloadOptions {
    detach?: boolean; // default false
}

await fr.preload({ detach: true });
```

By default `preload()` keeps the retained index/links ranges as zero-copy `subarray` **views** over the source buffer. That's cheapest when the buffer is short-lived or you opened from a `ByteReader` that owns it — but it means **the whole-file buffer stays alive** for as long as the reader does (any one view pins the entire backing `ArrayBuffer`).

`preload({ detach: true })` instead **copies** those ranges into their own small buffers and swaps the reader for a sentinel, so the source buffer becomes unreachable and is garbage-collected. What stays resident:

- the decoded feature cache (built by `preload` either way), and
- compact standalone copies of the spatial / adjacency / property indices.

Every query is still served from those caches — `getFeature`, `nearestFeatures`, `featuresInBbox`, `findFeaturesByText/Value`, `getLink(s)`, `outgoing/incomingLinksOf`, `shortestPath`, etc. all work with no further I/O.

Use it when **many datasets are kept resident at once** (e.g. hundreds of cached files): dropping each whole-file buffer removes a large, redundant copy of the payload — the encoded bytes are no longer needed once the features are decoded. The trade-off is a slightly higher transient peak during the load (the source buffer and the index copies briefly coexist) in exchange for a smaller steady-state footprint.

A detached instance is **sealed**: it can no longer fetch uncached bytes. The `release*` methods therefore throw on it (clearing a cache it can't rebuild would leave it broken) — to free a detached instance, drop all references to it (and re-open the file if you need it again). Pair `detach` with a full `preload` (the default), not partial `load*` calls, so nothing is left unloaded.

### `fr.inspect()`

Structured snapshot of the directory: every present block with its
byte offset, byte length, and percentage of the file; plus mode,
counts, schemas, indices present, and CRC32 verification status.

```typescript
interface FlatRecordInspect {
    mode: 'table' | 'geo' | 'graph' | 'geograph';
    featuresCount: number;
    linksCount: number;
    hasGeometry: boolean;
    featureColumns: Array<{ name: string; type: number }>;
    linkColumns: Array<{ name: string; type: number }>;
    indexes: {
        featureSpatialIndex: boolean;
        linkSpatialIndex: boolean;
        adjacencyIndex: boolean;
        reverseAdjacencyIndex: boolean;
        featureColumnIndices: string[];
        linkColumnIndices: string[];
    };
    crc32: { stored: number; verified: boolean };
    blocks: FlatRecordBlockInfo[];   // sorted by offset
    totalBytes: number;
}

interface FlatRecordBlockInfo {
    block: string;     // e.g. 'featuresBlock', 'featureColumnIndex[name]'
    offset: number;
    length: number;
    percent?: number;  // share of totalBytes
}
```

Useful when debugging "why is my file so big?" / "did the writer
emit the index I asked for?" — synchronous, no I/O, reads only the
already-parsed header.

## Property-index queries

### Text columns

`findFeaturesByText(column, query, options?)` and `findLinksByText(column, query, options?)`:

```typescript
interface TextQueryOptions {
    match?: 'prefix' | 'token' | 'exact';   // default: 'prefix'
    limit?: number;
}
```

- **Normalisation:** NFKD + diacritic strip + lowercase.
- **Tokenisation:** Unicode whitespace, punctuation, and symbols (so `"BR-116"` → `["br", "116"]`).
- **AND-intersect:** every query token must match (in any order).
- **Match modes:**
  - `'prefix'` (default): each query token can be a prefix of an indexed token. `"rio pre"` matches "São José do Rio **Pre**to".
  - `'token'`: each query token must equal an indexed token exactly. Use for code lookups.
  - `'exact'`: the full normalised query must equal the entire indexed value's token sequence.
- **Tier ranking:** results come back ordered by tier then earliest match position.
  - **A** — query tokens appear consecutive and in the query's order.
  - **B** — in order with gaps.
  - **C** — present, possibly out of order.

Each yielded hit carries the matched object plus `tier` and `index` (the storage index, so it can be fed straight into `getFeature` / `outgoingLinksOf` / `shortestPath`).

### Numeric / boolean columns

`findFeaturesByValue(column, predicate, options?)` and `findLinksByValue(column, predicate, options?)`:

```typescript
type ValuePredicate =
    | { eq: number | boolean }
    | { lt?: number; lte?: number; gt?: number; gte?: number };

interface ValueQueryOptions {
    limit?: number;
}
```

- Numeric columns support range predicates.
- Boolean columns support `eq: true | false`.
- Results yield the feature / link directly (no tier ranking).

### `featureIndexBy(lookup)`

```typescript
interface FeatureLookup {
    column: string;
    value: string | number | boolean;
}
```

Resolves a single feature by `{ column, value }` (the column must have been declared at write time):

- `string` value → text index, `match: 'exact'`.
- `number` value → numeric index, `eq:`.
- `boolean` value → bool index, `eq:`.

Throws when no record matches. `shortestPath` accepts the same descriptor inline, so you can pass `{ column, value }` directly anywhere a numeric feature index is expected.

## `ByteReader` interface

```typescript
interface ByteReader {
    read(offset: number, length: number): Promise<Uint8Array>;
    readAll?(): Promise<Uint8Array>;
}
```

Two ready-made factories ship with the package:

```typescript
function byteReaderFromUint8Array(bytes: Uint8Array): ByteReader;

interface UrlReaderOptions {
    headers?: HeadersInit;
    nocache?: boolean;
}
function byteReaderFromUrl(url: string, options?: UrlReaderOptions): ByteReader;
```

- `byteReaderFromUint8Array` — zero-copy `subarray` views; `readAll` returns the original buffer.
- `byteReaderFromUrl` — uses global `fetch` (Node ≥ 18, browser, React Native). `read` issues `Range:` requests (server must reply with HTTP 206/200); `readAll` does a plain GET.

For everything else — `fs.read`, mmap, IndexedDB, React Native filesystem libs, custom HTTP/2 clients — implement the interface yourself. Implementing `readAll` is optional but recommended; it lets `preload()` transfer the file in a single round-trip without needing Range support.
