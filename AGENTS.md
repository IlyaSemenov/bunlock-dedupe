# bunlock-dedupe Agent Guide

## Overview

CLI that analyzes, deduplicates, and updates dependencies in `bun.lock` files.

Read [README.md](README.md) completely before changing CLI behavior, supported runtimes, output, or user documentation.

Extend this guide only with stable, non-obvious conventions, architecture, contracts, workflows, and gotchas.
Do not catalog files or restate information evident from their names and locations.

## Scope

- Keep production code in `src/`.
- Use `src/*.test.ts` for focused tests of one source module.
- Keep fixture-driven integration cases in `test/fixtures/`.
- Keep `src/index.ts` limited to explicit public exports.
- Treat `package.json` exports, supported runtimes, CLI flags, and documented output as public contracts.

## Architecture

- Keep lockfile parsing and package tuple interpretation in `src/dedupe/parse.ts`.
- Keep duplicate analysis, dependency graph construction, and normal lock-key lookup in `src/dedupe/analyze.ts`.
- Keep dedupe rewrites, unreachable-entry pruning, and lockfile rendering in `src/dedupe/rewrite.ts`.
- Keep registry-backed update suggestions separate from update safety classification and application.
- Keep detailed report rendering separate from CLI orchestration and summary rendering.
- Keep registry access, persistent HTTP caching, and local Bun-cache metadata access behind their existing modules.

## Lockfile invariants

- Never write a lockfile in which a dependency range resolves to an incompatible version; `--update --fix` must validate the simulated final lockfile and skip offending updates.
- Treat top-level `bun.lock` overrides as the effective dependency ranges while preserving declared ranges for display.
- Treat prerelease compatibility with default semver range semantics; a prerelease satisfies only comparator sets that explicitly opt into a prerelease with the same major, minor, and patch tuple.
- Treat an optional peer as a reachability edge only when the resolved entry satisfies its effective range; keep unknown non-semver compatibility conservative.
- Run unreachable-entry pruning even when the current pass performs no dedupe rewrite, so an already-deduplicated lockfile can still be cleaned up.
- Track dedupe rewrites and unreachable-entry removals separately in result counters and CLI summaries.
- Dedupe rewrites operate per package version, not per lock entry: a version is rewritten only when every inbound request accepts the target.
- For a package requester, normal dependency lookup order is exact `requester/dependency`, closest ancestor-provided nested entry, then root `dependency`.
- For context-free lookup, use the root entry first and accept a nested entry only when it is the unique candidate.
- Use `resolveDependencyLockKey` from `src/dedupe/analyze.ts` for normal lookup.
- Use `resolveFallbackLockKey` from `src/dedupe/rewrite.ts` only to simulate lookup with an entry removed, preserving ancestor-before-root precedence.
- Use lock keys and requester node IDs for identity and safety decisions; use `requestPath` only for display.
- Preserve package key order during rendering.
- Sort dependency maps created from registry metadata by package name before rendering.
- Do not copy context-specific package tuple metadata such as `bundled` when reusing an entry as a rewrite template.
- Read package tuple metadata from the object slot and preserve its position: registry packages store it third, while git packages store it second.

## Documentation

- Write README and CLI text for users who do not know the implementation.
- Keep README content limited to CLI flags, workflow, and how to read the report.
- Add JSDoc to every exported declaration and to internal helpers whose contract, inputs, output, or failure behavior is not obvious.
- Add inline comments beside every non-obvious invariant, algorithmic choice, safety constraint, and intentionally limited behavior.
- Update nearby JSDoc and inline comments whenever the documented code changes, and remove comments that no longer apply.
- Do not narrate self-evident syntax or restate what a name already communicates.
- Do not document obvious or implied defaults.
- Describe a default only when readers need it to make a decision or avoid surprising behavior.
- Use One Sentence Per Line for connected prose.
- Keep semantically connected explanations as prose paragraphs.
- Use lists for separate assertions instead of presenting them as prose paragraphs.

## Tests

- Prefer a fixture for user-visible report or rewrite regressions; use a unit test only when the behavior is an isolated algorithm that the fixture pipeline does not expose clearly.
- Treat `test/fixtures/<name>/` directories as auto-discovered by `test/fixtures.test.ts`.
- Generate expected fixture files by running the real pipeline and reviewing its output; do not hand-write them.
- When a behavior change trivializes a fixture's output, adapt the fixture so its named scenario stays observable instead of only rewriting the expected report.
- Add a `describe` block where the file gives a reason for it: several APIs or behaviors in one file, or a fixture that belongs to some cases but not all.
- Name such a block after what it covers and keep its fixtures inside it.
- Distinguish several same-kind values by role rather than by order.
- When values differ only by order, number them with digits instead of ordinal words.
- Keep tests deterministic so a failure repeats on every run.
- Generate random inputs from an explicit seed and print the seed in failure messages so the failing input can be replayed.

## Reproductions

- Treat supplied lockfiles as read-only and run `--fix` only on a copy.
- Save large CLI reports to a temporary file and extract only the relevant package block for inspection.
- In a `used by` line, the path ends at the requester, the group heading names the requested package, and the suffix is the requester's declared range.

## Changesets

- Add one `.changeset/*.md` file for each independently releasable user-visible change.
- Do not add changesets for internal refactors, maintenance, tests, or documentation changes that do not require a package release.
- Choose the SemVer bump from the public contract: `patch` for backward-compatible fixes, `minor` for backward-compatible functionality, and `major` for breaking changes.
- Create `.changeset/<unique-name>.md` with this format:

```markdown
---
"bunlock-dedupe": patch
---

Describe the user-visible change.
```

- Write one or two concise sentences for CLI users describing the observable change or new capability.
  Avoid implementation details and rationale.
- Do not edit the package version or `CHANGELOG.md` by hand, and do not run `changeset version` or `changeset publish`; the release workflow consumes pending changesets.

## Checks

- Run `bun run types` when public types, shared interfaces, or TypeScript configuration change.
- Run `bun test` when behavior changes.
- Run `bun run build` when package exports, declarations, or supported runtimes change.
- Treat `bun run lint` and `bun run check` as mutating commands because they invoke Biome with auto-fixes.
