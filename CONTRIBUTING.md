# Contributing

Thanks for your interest in FlatRecord. This page covers the practical
basics: how to set up a dev environment, what each script does, and
the conventions the project follows.

## Local setup

You'll need:

- Node.js ≥ 18 (the package targets ESM-only Node, no CommonJS shim)
- [`pnpm`](https://pnpm.io) — the lockfile is pnpm-flavoured

```bash
git clone https://github.com/cristianob/flatrecord.git
cd flatrecord
pnpm install
```

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm type-check` | Strict TypeScript check over `src/` (no emit). Fast — run on every save. |
| `pnpm test` | Vitest unit tests (`test/unit/`). ~4 000 tests, < 3 s. |
| `pnpm coverage` | Same as `test` with `@vitest/coverage-v8`. |
| `pnpm build` | Compile to `lib/mjs/` (swc) + emit `.d.ts` (tsc) + bundle `dist/` (rollup). |
| `pnpm fixtures` | Regenerate the pinned `test/data/*.frb` fixtures (run when you change the wire format). |
| `pnpm typedoc` | Generate the HTML API docs into `docs/`. |
| `pnpm test:browser` | Playwright smoke test of the dist bundles in real browsers. Optional locally; only required for release. |

## Project layout

```
src/
├── fbs/             # .fbs FlatBuffer schemas (canonical wire format)
├── ts/
│   ├── index.ts     # Umbrella entry point
│   ├── geojson.ts   # Public GeoJSON-facing API (`flatrecord/geojson`)
│   ├── flat-record.ts        # `FlatRecord` class (random-access reader)
│   ├── codec/                # Feature/geometry FlatBuffer codec helpers
│   ├── geojson/              # GeoJSON-specific feature codec
│   ├── fbs/                  # Generated TS bindings for `src/fbs/*.fbs`
│   └── *.ts                  # Building blocks (file-builder, byte-reader, property-index, …)
test/
├── unit/            # Vitest specs — most of the project's coverage
├── data/            # Pinned binary fixtures (regenerate via `pnpm fixtures`)
├── browser-smoke.html
└── smoke.browser.spec.ts     # Playwright spec
doc/                 # User-facing markdown (format-spec, api-reference, …)
bench/               # Performance benchmarks (see below)
```

## Wire-format changes

The flatbuffer header is **append-only**. The full set of rules lives
at the top of [`src/fbs/header.fbs`](src/fbs/header.fbs); the short
version:

1. New fields go at the **end** of the table — never insert in the
   middle.
2. Never reorder, remove, or retype existing fields.
3. Defaults must equal previously-implicit behavior (a new bool
   added today must default to whatever absence meant before).
4. Hand-update `src/ts/fbs/header.ts` to match: new getter at the
   next vtable offset, new `addX` at the next slot ID, bump
   `startObject(N)`.
5. Regenerate fixtures (`pnpm fixtures`) and verify
   `test/unit/wire-format.spec.ts` still passes — those byte-offset
   assertions are the tripwire that forces you to be conscious about
   any layout change.

Bumping the magic byte (byte 3 of the file) is a **hard break**.
Old readers reject foreign majors at `open()`. Only do it when you
genuinely want incompatibility (e.g. an irreconcilable schema
change).

## Adding a new index / block

1. Add the directory entry pair (`new_block_offset: ulong`,
   `new_block_length: ulong`) at the **end** of the `Header` table
   in `src/fbs/header.fbs`. Both default `0` (= absent).
2. Mirror in `src/ts/fbs/header.ts` (getter + adder + startObject bump).
3. Extend `HeaderMeta` in `src/ts/header-meta.ts` and parse the new
   slot in `fromByteBuffer`.
4. Extend `FileBuildSpec` in `src/ts/file-builder.ts` and write the
   new block in `buildFile`.
5. Add the reader-side methods on `FlatRecord` (and a release/load
   pair if it's worth caching).
6. Cover with a permutation in `test/unit/permutations.spec.ts` plus
   targeted positive/negative tests in a fresh `*.spec.ts`.
7. Document in `doc/format-spec.md` and `doc/format-changelog.md`.

The pattern is well-established by the reverse adjacency CSR — read
that diff for a worked example.

## Testing conventions

- **Permutation matrices** (`permutations.spec.ts`,
  `tabular-permutations.spec.ts`) exhaustively combine writer flags
  with data shapes. New options should fit one of those matrices.
- **Wire-format spec** (`wire-format.spec.ts`) pins exact byte
  offsets of blocks in pinned fixtures. Update the pins consciously.
- **Preload symmetry** (`preload-symmetry.spec.ts`) asserts that
  cold-cache reads agree with warm-cache reads byte-for-byte. New
  methods that touch the I/O paths should be added here.
- **Performance** (`scale.spec.ts`, the `text-search-large.frb`
  fixture) covers latency budgets. Loose-enough thresholds that they
  don't flake on slow CI runners.

Aim for both happy-path and "this method must throw because the
required index isn't there" coverage.

## Coding conventions

- TypeScript strict, `noImplicitAny`, no `any` outside flatbuffer
  glue.
- No comments that just restate the code. Inline comments explain
  *why*, not *what*.
- Prefer narrow, named types over inline unions in the public
  surface. The public types are part of the contract.
- Lint via the project's biome config (`pnpm biome check`); follow
  existing two-space indent and import-ordering conventions.

## Release checklist

1. `pnpm type-check && pnpm test && pnpm build`
2. `pnpm fixtures` (verify no fixture drift — clean diff means the
   wire format didn't change)
3. Update `CHANGELOG.md` with the user-facing changes
4. Update `doc/format-changelog.md` if and only if the wire format
   changed
5. Bump `package.json` version per semver
6. `git tag vX.Y.Z && git push --tags`
7. `npm publish` (the `prepublishOnly` script runs type-check + test
   + build + browser smoke)

## Reporting bugs / proposing changes

Open an issue at https://github.com/cristianob/flatrecord/issues
with:

- What you tried (input data + serialize/deserialize options)
- What you expected
- What happened (error message, stack, file size if relevant)
- For wire-format bugs: a minimal `.frb` reproducer attached, plus
  the writer command that produced it.
