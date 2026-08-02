---
"bunlock-dedupe": patch
---

Prevent stable dependency ranges from selecting or deduplicating to prerelease package versions unless the range explicitly opts in.
Existing prerelease resolutions that do not satisfy their range are now reported as invalid.
