---
"bunlock-dedupe": patch
---

Fix dedupe fixpoint cleanup so `--fix` removes newly unlocked and unreachable lock entries without requiring a second `bun install`.
