---
"bunlock-dedupe": patch
---

When a broken `bun.lock` resolves a dependency outside its declared range, duplicate reports now identify the invalid resolution.
