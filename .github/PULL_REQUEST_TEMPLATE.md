## What

<!-- 1-2 sentences. The "why" goes in the next section. -->

## Why

<!-- The user-facing motivation. What was hard / impossible / wrong before? -->

## Notes for the reviewer

<!--
- Wire-format change? Confirm append-only rules followed (see CONTRIBUTING.md)
  and that `pnpm fixtures` was re-run.
- New public method? Confirm covered in test/unit/permutations.spec.ts
  or its tabular sibling, and in preload-symmetry.spec.ts.
- New writer option? Mention default and the rationale.
-->

## Checklist

- [ ] `pnpm type-check` passes
- [ ] `pnpm test` passes
- [ ] Tests added / updated
- [ ] CHANGELOG.md / doc/format-changelog.md updated when user-facing
- [ ] No regressions in `pnpm bench` (paste before/after for hot paths if relevant)
