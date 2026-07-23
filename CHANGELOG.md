# bunlock-dedupe

## 1.6.4

### Patch Changes

- 9898a14: Separate requests that block deduplication from other consumers of the same incompatible version.

## 1.6.3

### Patch Changes

- cd0638c: Remove redundant nested packages after deduping dependencies of scoped packages.

## 1.6.2

### Patch Changes

- 8c26466: Resolve nested dependency requests through their closest ancestor lock entry so compatible root versions are no longer incorrectly blocked from deduplication.

## 1.6.1

### Patch Changes

- 7f24581: Fix `--update --fix` writing an inconsistent lockfile when a duplicate version is also pinned by a package that has no update of its own; such updates are no longer suggested or applied, and the report now reflects the written lockfile.
- 69c86cc: Qualify `removed after` entries with the full dependency path when the same package name stands for different changes in one block.
- f9a6c78: Sort dependency maps in updated `bun.lock` package metadata to avoid a follow-up diff from Bun.

## 1.6.0

### Minor Changes

- 93c9258: Find `bun.lock` by walking up parent directories when no path is given.

## 1.5.4

### Patch Changes

- 4f4c807: Render each `required by` constraint on its own line instead of comma-joining.

## 1.5.3

### Patch Changes

- 4bbc26d: Add TTY progress when doing `--update`.
- f37fabb: Cache registry packuments to dedupe network requests.
- 37f595d: Fail fast on registry errors when called with `--update`.
- d6782f1: Preserve original `bun.lock` package key order instead of re-sorting, fixing parasitic reordering of unrelated entries (e.g. `@nuxt/devtools-kit/...` vs `@nuxt/devtools/...`).

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
