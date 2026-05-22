# FlatRecord Format Specification

Version 1.0.0

## Overview

FlatRecord is a binary format for **tabular records, optionally
decorated with per-feature geometry and/or a directed adjacency list
(links)**. A single file may be one of four **modes**, inferred from
its content:

| Mode | Geometry? | Links? |
|---|---|---|
| `table` | no | no |
| `geo` | yes | no |
| `graph` | no | yes |
| `geograph` | yes | yes |

The format extends FlatBuffers with a directory header that locates
every payload block by absolute file offset. Readers can therefore
fetch only the blocks they need, even over HTTP range requests.

## File layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ Magic bytes (8B)            │ 0x6672620166726200 ("frb\x01frb\x00")  │
│ Header size (4B)            │ uint32 little-endian                   │
│ Header (FlatBuffer table)   │ Includes the block directory           │
│ Header CRC32 (4B)           │ uint32 LE — 0 = "not computed"         │
├─────────────────────────────────────────────────────────────────────┤
│ Payload blocks (any order, located by directory offsets in header)  │
│                                                                     │
│  - Feature property index blocks (one per indexed column, opt.)     │
│  - Feature spatial R-tree block (optional)                          │
│  - Features block (size-prefixed Feature records, opt.)             │
│  - Link property index blocks (one per indexed column, opt.)        │
│  - Link spatial R-tree block (optional)                             │
│  - Link adjacency CSR block (optional)                              │
│  - Link reverse adjacency CSR block (optional)                      │
│  - Links block (size-prefixed Link records, opt.)                   │
└─────────────────────────────────────────────────────────────────────┘
```

The writer in this repository always emits blocks in the order listed
above; readers MUST NOT assume any specific order and must resolve
every block via the directory.

The **CRC32 slot** (4 bytes) sits between the flatbuffer header and the
first payload block. When non-zero it stores the IEEE 802.3 CRC32 over
the header bytes (the bytes from offset 8 through `8 + 4 + header_size`,
i.e. the size-prefixed flatbuffer header). Readers MUST verify and
fail-fast on mismatch; a value of `0` means the writer did not compute
one and the reader skips verification. The slot lives outside the
flatbuffer because embedding it would break the two-pass writer's
stable-header-size invariant.

## Magic bytes

8 bytes: `0x66 0x72 0x62 0x01 0x66 0x72 0x62 0x00`

- Bytes 0-2: ASCII `"frb"`
- Byte 3: Major version (`0x01`)
- Bytes 4-6: ASCII `"frb"`
- Byte 7: Patch version (`0x00`)

A reader MUST reject any buffer whose bytes 0-3 are not exactly
`0x66 0x72 0x62 0x01`.

## Header

A FlatBuffer `Header` table (see `src/fbs/header.fbs`), preceded by
the standard 4-byte size prefix.

### Schema essentials

Fields are listed in slot-ID order (which is the wire layout order
inside the flatbuffer vtable). See `src/fbs/header.fbs` for the
canonical source.

```
table Header {
  // Identity (textual, no parse semantics)
  name, title, description, metadata: string;
  timestamp: long = 0;                // Unix-time-in-ms; 0 = not set

  // Spatial reference (applies to features AND link LineStrings)
  crs: Crs;

  // Geometry shape (mode determiners)
  geometry_type: GeometryType;        // Unknown = heterogeneous OR absent
  has_z, has_m, has_t, has_tm: bool = false;
  has_feature_geometry: bool = true;  // false ⇒ no geometry at all (tabular)

  // Feature side — bounds, schema, directory
  envelope: [double];
  features_count: ulong;
  columns: [Column];                  // Feature column schema
  index_node_size: ushort = 16;       // R-tree fanout (features + links)
  feature_spatial_index_offset:  ulong;
  feature_spatial_index_length:  ulong;
  feature_column_indices:        [ColumnIndexEntry];
  features_offset:               ulong;
  features_length:               ulong;

  // Link side — populated when the file has links
  links_count:                   ulong;
  link_columns:                  [Column];
  link_spatial_index_offset:     ulong;
  link_spatial_index_length:     ulong;
  link_column_indices:           [ColumnIndexEntry];
  link_adjacency_index_offset:   ulong;
  link_adjacency_index_length:   ulong;
  link_reverse_adjacency_index_offset:  ulong;
  link_reverse_adjacency_index_length:  ulong;
  links_offset:                  ulong;
  links_length:                  ulong;
}

table ColumnIndexEntry {
  name:    string (required);
  offset:  ulong;
  length:  ulong;
}
```

### Mode inference

`has_feature_geometry` and the presence of links together determine the
file's mode:

| `has_feature_geometry` | `links_count` | Mode |
|---|---|---|
| `false` | `0` | `table` |
| `true` | `0` | `geo` |
| `false` | > 0 | `graph` |
| `true` | > 0 | `geograph` |

When `has_feature_geometry == false`, the per-feature `geometry`
FlatBuffer table is omitted from each `Feature` record. The features
block is then a pure tabular store.

`geometry_type` distinguishes uniform-typed (e.g. `Point`) from
heterogeneous datasets (`Unknown`, where each feature carries its own
type). It applies only when `has_feature_geometry == true`.

## Blocks

### Features block

Concatenated size-prefixed FlatBuffer `Feature` records:

```
[size:4B uint32][Feature payload: size B] [size:4B][Feature payload] …
```

The `Feature` table is reused from FlatGeobuf:

```
table Feature {
  geometry: Geometry;   // omitted when header.geometry_type == Unknown
  properties: [ubyte];  // variable-length key/value pairs, keys are ushort column indices
  columns: [Column];    // optional per-feature schema override
}
```

`features_offset` / `features_length` in the directory locate the
block. The reader iterates by walking size prefixes; random access by
storage index requires the feature spatial index (otherwise the reader
bulk-parses the section).

### Feature spatial index block

A packed Hilbert R-tree over the bounding boxes of every feature, with
each leaf pointing at the byte offset of the corresponding feature
record (relative to the start of the features block). Internal node
format unchanged from FlatGeobuf — see `packedrtree.ts`.

Located by `feature_spatial_index_offset` / `_length`. Absent when
`length == 0`.

### Feature column index blocks (per indexed column)

One block per indexed column, located by `feature_column_indices[i]`
entries. Each entry's `name` is the column's name; `offset` / `length`
point at the block's raw bytes in the file.

Inside the block: a self-describing property-index payload that lists
exactly one column. See the **Property index block format** section
below for the byte layout.

### Links block

Concatenated size-prefixed Link records:

```
[size:4B uint32][Link payload: size B] [size:4B][Link payload] …
```

Each Link record has the layout:

```
[from:4B uint32][to:4B uint32]
[geometry_point_count:4B uint32]
[geometry_xy:Float64×2×point_count]  // omitted if point_count == 0
[properties:variable]
```

Link properties use the same column-indexed encoding as Features (no
FlatBuffer envelope, just `[ushort:column_idx][value]…`).

Located by `links_offset` / `links_length`. Absent in `table` / `geo`
modes.

### Link spatial index block

Packed Hilbert R-tree over link bounding boxes. Leaf offsets point at
byte positions in the links block.

Located by `link_spatial_index_offset` / `_length`.

### Link adjacency index block (CSR)

A compressed sparse row offsets table:

```
[off_0:4B uint32][off_1:4B uint32] … [off_N:4B uint32]
```

`N = features_count`, so the table has `N+1` 32-bit offsets. Entry `i`
is the byte offset (within the links block) of the first outgoing
link of feature `i`; entry `N` is the total links-block length.
Outgoing links of feature `v` span `[off_v, off_{v+1})`.

Requires links to be physically sorted by `from` ascending. The writer
in this repository does this whenever `writeAdjacencyIndex: true`.

Located by `link_adjacency_index_offset` / `_length`. Absent when 0.

### Link reverse adjacency index block (reverse CSR)

Enables O(deg) `incomingLinksOf(v)` lookup. Block layout:

```
[csrOffsets:    uint32 × (N+1)]   // index ranges into linkByteOffsets
[linkByteOffsets: uint32 × L]     // byte offsets into the links block
```

- `csrOffsets[v]` is the index into `linkByteOffsets` of the first
  incoming link of feature `v`. Entry `N` (= `features_count`) is the
  total number of incoming links across the dataset, so
  `csrOffsets[v+1] - csrOffsets[v] == inDegree(v)`.
- `linkByteOffsets[i]` is the byte offset (within the links block) of
  one link record. Entries are sorted by the link's `to` field
  ascending, so the slice `linkByteOffsets[csrOffsets[v]..csrOffsets[v+1])`
  lists every link that ends at `v`, in storage order.

To read incoming links of `v`: look up the range in `csrOffsets`, then
fetch each byte offset from `linkByteOffsets` and read the link at that
offset in the links block.

Located by `link_reverse_adjacency_index_offset` / `_length`. Absent
when 0. The writer in this repository emits it whenever
`writeReverseAdjacencyIndex: true` (default).

### Link column index blocks (per indexed column)

Same shape as feature column index blocks, but indexing storage
positions of links instead of features.

## Property index block format

Each property-index block describes one or more columns. Three column
kinds are supported, chosen at write time from each value's runtime
type:

- **text** — NFKD-normalised, diacritic-stripped, lowercased, then
  whitespace/punctuation-tokenised. Stored as a sorted
  `(token, recordId, position)` entry list plus a deduplicated token
  pool and a per-record total-token count.
- **number** — sorted `(value: f64, recordId: u32)` entries (12 bytes
  each). Supports range queries.
- **boolean** — two posting lists (`true`, `false`) of recordIds.

Byte layout of the block content (the directory entry covers exactly
these bytes — there is no internal size prefix):

```
[text_column_count: u32]
  for each text column:
    [name_len: u32][name: UTF-8]
    [token_pool_len: u32][token_pool bytes]
    [total_tokens_len: u32][total_tokens: u16 × records]
    [entries_len: u32][entries bytes]

[numeric_column_count: u32]
  for each numeric column:
    [name_len: u32][name: UTF-8]
    [entries_len: u32][entries bytes]   // 12 bytes per (f64 + u32) entry

[boolean_column_count: u32]
  for each boolean column:
    [name_len: u32][name: UTF-8]
    [true_list_len: u32][trueList: u32 × count]
    [false_list_len: u32][falseList: u32 × count]
```

When the writer emits a block per column (as this repository's writer
does), exactly one of the three column-count fields will be non-zero
in each block.

## Forward compatibility

The Header table can grow new fields without breaking existing
readers — FlatBuffers returns the field's default (`0` / `null` /
empty vector) when an older reader sees a file that omits a newer
field. New optional blocks become new directory entries; their
presence is implicit (length > 0).

Within the property-index block, three column kinds are versioned by
position (text / numeric / boolean). Adding a fourth kind would
require a new field in the Header so older readers know to skip the
new block. The block format itself is not forward-compatible — a
writer must never emit a column kind unknown to its declared file
version.

## Streaming

The file is **not** strictly streamable in the FlatGeobuf sense: a
reader needs the header (and therefore the directory) before any
block makes sense. In practice, a reader can:

1. Stream until the header is fully buffered (8 + 4 + header_size
   bytes from start).
2. Parse the directory.
3. Stream the remainder, parsing blocks as their byte ranges arrive
   — provided the writer emitted them in a known order.

The reference writer's order is documented above. A reader that
wants to be order-independent should random-access via offsets.
