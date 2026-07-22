# bunlock-dedupe

CLI that dedupes and updates `bun.lock` entries.
Treat README.md as the user-facing behavior contract.

## Commands

- `bun test` runs the test suite, and `bun run types` runs the typecheck.
- `bun run lint` runs Biome with auto-fixes, and `bun run check` includes that mutating lint step after the typecheck.

## Code map

- `src/cli.ts`, `src/read-bun-lock.ts` — CLI flow and lockfile discovery.
- `src/dedupe/parse.ts` — parsed lockfile types, package tuple metadata, and resolved-spec parsing.
- `src/dedupe/analyze.ts` — duplicate analysis, dependency graph, shared lock-key resolver.
- `src/dedupe/rewrite.ts` — dedupe rewrites, pruning, lockfile rendering.
- `src/dedupe/update-analyze.ts` — registry-backed update suggestions.
- `src/dedupe/update-fix.ts` — safety classification and application of updates for `--update --fix`.
- `src/dedupe/format.ts`, `src/cli-messages.ts` — detailed report and summary rendering.
- `src/registry.ts` — registry and local Bun-cache metadata access.

## Lockfile invariants

- Never write a lockfile in which a dependency range resolves to an incompatible version; `--update --fix` must validate the simulated final lockfile and skip offending updates.
- Dedupe rewrites operate per package version, not per lock entry: a version is rewritten only when every inbound request accepts the target.
- For a package requester, normal dependency lookup order is exact `requester/dependency`, closest ancestor-provided nested entry, then root `dependency`.
- For context-free lookup, use the root entry first and accept a nested entry only when it is the unique candidate.
- Use `resolveDependencyLockKey` from `analyze.ts` for normal lookup; `resolveFallbackLockKey` in `rewrite.ts` is only for simulating lookup with an entry removed and must keep the same ancestor-before-root precedence.
- Use lock keys and requester node IDs for identity and safety decisions; use `requestPath` only for display.
- Preserve package key order during rendering.
- Sort dependency maps created from registry metadata by package name before rendering.
- Do not copy context-specific package tuple metadata such as `bundled` when reusing an entry as a rewrite template.

## Fixtures

- `test/fixtures/<name>/` directories are auto-discovered by `test/fixtures.test.ts`.
- Prefer a fixture for user-visible report or rewrite regressions; use a unit test only when the behavior is an isolated algorithm that the fixture pipeline does not expose clearly.
- Generate expected files by running the real pipeline and reviewing its output; do not hand-write them.
- When a behavior change trivializes a fixture's output, adapt the fixture so its named scenario stays observable; do not just rewrite the expected report.

## Reproductions

- Treat supplied lockfiles as read-only and run `--fix` only on a copy.
- Save large CLI reports to a temporary file and extract only the relevant package block for inspection.
- In a `used by` line, the path ends at the requester, the group heading names the requested package, and the suffix is the requester's declared range.

## Changesets and README

- Every user-visible change gets a `.changeset/*.md` entry: one or two sentences describing the visible behavior change from the CLI user's perspective, without implementation details or rationale.
- Never edit `CHANGELOG.md` by hand; it is generated from changesets.
- README documents only what a CLI user needs: flags, workflow, and how to read the report.
- Keep README additions brief and leave internal mechanics to code comments or this file.
