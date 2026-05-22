# FlatRecord — TypeScript source

## Building

### Prerequisites

You must have [`pnpm`](https://pnpm.io) installed.

### Install dependencies

```bash
pnpm install
```

### Build

```bash
pnpm build
```

### Testing

```bash
pnpm test            # unit tests (test/unit/)
pnpm test:browser    # playwright smoke (test/smoke.browser.spec.ts)
pnpm type-check
```

See the `scripts` section in [package.json](../../package.json) for other actions.

## Project Structure

```
src/ts/
├── index.ts              # Public umbrella entry point
├── geojson.ts            # GeoJSON-facing public API (subpath: flatrecord/geojson)
├── flat-record.ts        # FlatRecord — random-access reader class
├── link.ts               # Link record primitives (encode/decode)
├── link-types.ts         # Link, AdjacencyList, FlatRecordMeta, Row types
├── header-meta.ts        # Header + directory parsing
├── file-builder.ts       # Two-pass writer that emits the directory header
├── property-index.ts     # Per-column property index block format
├── shortest-path.ts      # A* / Dijkstra over the link adjacency CSR
├── packedrtree.ts        # Hilbert R-tree streaming query
├── packedrtree-writer.ts # R-tree builder
├── byte-reader.ts        # ByteReader abstraction (in-memory + HTTP factories)
├── column-meta.ts        # Column schema introspection
├── crs-meta.ts           # CRS metadata type
├── constants.ts          # Magic bytes, size-prefix length
├── geojson/              # GeoJSON-specific feature codec
├── codec/                # FlatBuffer feature/geometry codec helpers
└── fbs/                  # FlatBuffers generated bindings (mirrors src/fbs/*.fbs)
```

Tests live in `test/unit/` (vitest) and `test/` (playwright smoke).

## Usage example

```typescript
import { serialize, deserialize } from './geojson.js';
import type { AdjacencyListInput } from './link-types.js';

const geojson = {
    type: 'FeatureCollection',
    features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'A' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { name: 'B' } },
    ],
};

const adjacency: AdjacencyListInput = {
    links: [{ from: 0, to: 1, properties: { weight: 1.5 } }],
};

const bytes = serialize(geojson, adjacency);

const result = await deserialize(bytes);
if (result.mode === 'geo' || result.mode === 'geograph') console.log(result.features);
console.log(result.adjacencyList.links);
```
