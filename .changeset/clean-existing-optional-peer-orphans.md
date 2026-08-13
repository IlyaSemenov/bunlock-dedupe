---
"bunlock-dedupe": patch
---

`--fix` now removes unreachable optional-peer package entries even when the lockfile was already deduplicated by an earlier run.
Reports now show when unreachable entries can be or were removed.
