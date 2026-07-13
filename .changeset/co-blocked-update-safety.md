---
"bunlock-dedupe": patch
---

Fix `--update --fix` writing an inconsistent lockfile when a duplicate version is also pinned by a package that has no update of its own; such updates are no longer suggested or applied, and the report now reflects the written lockfile.
