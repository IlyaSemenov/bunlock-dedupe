---
"bunlock-dedupe": patch
---

Preserve original `bun.lock` package key order instead of re-sorting, fixing parasitic reordering of unrelated entries (e.g. `@nuxt/devtools-kit/...` vs `@nuxt/devtools/...`).
