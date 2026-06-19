# bunlock-dedupe

## 1.5.2

### Patch Changes

- 0be4684: Fix leaking bundled metadata when reusing lockfile entries.

## 1.5.1

### Patch Changes

- aa1a530: Fix dedupe fixpoint cleanup so `--fix` removes newly unlocked and unreachable lock entries without requiring a second `bun install`.

## 1.5.0

### Minor Changes

- 717f394: Inline update suggestions into per-version `used by` / `removed after` sections and explain held-back updates (✋) with their constraining ranges and reasons.

### Patch Changes

- ab56162: Remove nested entries that became redundant after rewrites.

## 1.4.0

### Minor Changes

- 879a2cf: Add `--update`, `--update --fix`, and `--offline` flags to find intermediate dependency updates that unlock deduplication. Offline mode is analysis-only because Bun's package cache does not include registry integrity metadata needed for safe lockfile rewrites.
- e283d65: Replace `--fixable` with `--all` and invert default to fixable-only output.

### Patch Changes

- cf767f3: Fix transitive orphan detection with iterative orphan propagation.
- eaa9cb9: Improve summary CTA texts.

## 1.3.1

### Patch Changes

- 9581b39: Include orphans in `--fixable` output.

## 1.3.0

### Minor Changes

- 89399c7: Add summary report after analysis and fix.

### Patch Changes

- 467a2d3: Fix: align `bun.lock` key sorting with Bun package-path order.

## 1.2.0

### Minor Changes

- 18308dd: Detect orphan versions that become unreachable after deduplication.

## 1.1.1

### Patch Changes

- c1f7cb3: Remove orphaned nested `bun.lock` entries after dedupe.

## 1.1.0

### Minor Changes

- ba41f8a: Add `--fixable` option.

### Patch Changes

- 76d66d6: Remove extra trailing comma in a fixed `bun.lock`.
- 6b9553b: Fix sorting of deeply nested deps in `bun.lock`.

## 1.0.0

### Major Changes

- 6d45bc4: Initial release.
