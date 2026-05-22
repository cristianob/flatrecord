# Format specification changelog

Wire-format-only changes to FlatRecord (the `.frb` binary container).
This is separate from [`CHANGELOG.md`](../CHANGELOG.md), which tracks
package-level (npm) changes; not every package release ships a format
change.

## FlatRecord 1.0.0 — Initial format

### File layout

```
[Magic 8B "frb\x01frb\x00"]    ← major version 0x01
[FB hdr size 4B][FB hdr (includes directory)]
[Header CRC32 4B]              ← IEEE 802.3 CRC over header bytes; 0 = "not computed"
[Payload blocks in any order, located by directory offsets]
```

### Magic bytes

`0x66 0x72 0x62 0x01 0x66 0x72 0x62 0x00`

- Bytes 0-2, 4-6: ASCII `"frb"`
- Byte 3: major version (`0x01`) — the gate. Bumping it is a hard
  break; readers reject foreign majors at `open()`.
- Byte 7: patch version (`0x00`) — informational; readers ignore.

### Header

A flatbuffer table describing identity, geometry shape, feature side,
and link side. See `src/fbs/header.fbs` for the canonical schema and
`doc/format-spec.md` for the prose specification. The header carries
a **directory** of absolute byte offsets to every payload block; this
is the only way a reader locates anything inside the file.

Directory fields (all default 0 = absent):

```
// Feature side
feature_spatial_index_offset:        ulong
feature_spatial_index_length:        ulong
feature_column_indices:              [ColumnIndexEntry]
features_offset:                     ulong
features_length:                     ulong

// Link side
links_count:                         ulong
link_columns:                        [Column]
link_spatial_index_offset:           ulong
link_spatial_index_length:           ulong
link_column_indices:                 [ColumnIndexEntry]
link_adjacency_index_offset:         ulong
link_adjacency_index_length:         ulong
link_reverse_adjacency_index_offset: ulong
link_reverse_adjacency_index_length: ulong
links_offset:                        ulong
links_length:                        ulong

// Identity / shape
timestamp:               long = 0    // Unix-time-ms; 0 = unset
has_feature_geometry:    bool = true // false ⇒ tabular (no per-feature geometry)

ColumnIndexEntry { name: string, offset: ulong, length: ulong }
```

### Mode inference

`has_feature_geometry` and presence of links together determine the
file's mode:

| `has_feature_geometry` | `links_count` | Mode       |
|------------------------|---------------|------------|
| `false`                | `0`           | `table`    |
| `true`                 | `0`           | `geo`      |
| `false`                | > 0           | `graph`    |
| `true`                 | > 0           | `geograph` |

When `has_feature_geometry == false`, the per-feature `geometry`
table is omitted from each `Feature` record; the features block
becomes a pure tabular store. `geometry_type: Unknown` (without
`has_feature_geometry: false`) means heterogeneous: each feature
carries its own geometry type.

### Blocks

All blocks are optional and located via the directory. The reference
writer emits them in the order below; readers MUST NOT assume any
order.

- **Feature payload** — concatenated size-prefixed FlatBuffer
  `Feature` records. The `Feature` table is the FlatGeobuf shape:
  `{ geometry?, properties: [ubyte], columns?: [Column] }`.
- **Feature spatial index** — packed Hilbert R-tree over feature
  bboxes. Each leaf's offset field is the byte offset of the feature
  record (relative to `features_offset`).
- **Feature column index blocks** — one block per indexed column.
  Self-describing property-index payload supporting text (tiered),
  numeric (range), and boolean (equality) queries.
- **Link payload** — concatenated size-prefixed Link records:
  ```
  [from:4B uint32][to:4B uint32]
  [geometry_point_count:4B uint32]
  [geometry_xy:Float64×2×point_count]   // omitted if point_count == 0
  [properties:variable]                  // same column-indexed encoding as features
  ```
- **Link spatial index** — packed Hilbert R-tree over link bboxes
  (each link's bbox = its endpoint features' bbox union, plus any
  LineString geometry).
- **Link adjacency CSR** — `uint32 × (N+1)` byte offsets into the
  links block. Outgoing range of feature `v` is `[off_v, off_{v+1})`.
  Requires links to be physically sorted by `from`.
- **Link reverse adjacency CSR** — `[csrOffsets: uint32 × (N+1)]
  [linkByteOffsets: uint32 × L]`. `csrOffsets[v+1] - csrOffsets[v] ==
  inDegree(v)`; `linkByteOffsets[csrOffsets[v]..csrOffsets[v+1])` are
  byte offsets of links with `link.to === v`.
- **Link column index blocks** — same shape as feature column
  indices, addressed by storage positions of links.

### CRC32 slot

Four bytes immediately after the size-prefixed header bytes. When
non-zero, it's the IEEE 802.3 CRC32 of the header bytes (the slice
from offset 8 through `8 + 4 + header_size`). A `0` value means the
writer didn't compute one and readers skip verification. The slot
lives outside the flatbuffer because embedding it would break the
two-pass writer's stable-header-size invariant.

### Forward compatibility

- Adding a new directory entry (e.g. a new optional index) is
  forward-compat: append the `offset` / `length` ulongs at the end of
  the `Header` flatbuffer table. Old readers see the missing slot as
  default 0, treat the block as absent, ignore it.
- Adding a new top-level Header field follows the same rule.
- The append-only and "never reorder, never remove, never retype"
  rules are documented at the top of `src/fbs/header.fbs`.
- Any change that violates those rules requires bumping the magic
  byte at file offset 3. Currently `0x01`. Bumping is a hard break;
  readers reject foreign majors.
