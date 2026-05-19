---
"bunlock-dedupe": minor
---

Add `--update`, `--update --fix`, and `--offline` flags to find intermediate dependency updates that unlock deduplication. Offline mode is analysis-only because Bun's package cache does not include registry integrity metadata needed for safe lockfile rewrites.
