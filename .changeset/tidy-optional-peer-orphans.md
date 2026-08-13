---
"bunlock-dedupe": patch
---

`--fix` now removes transitive package entries that become unreachable after deduplication when an optional peer cannot accept their version.
