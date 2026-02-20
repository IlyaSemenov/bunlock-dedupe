# bunlock-dedupe

`bunlock-dedupe` finds and fixes duplicate package versions in your `bun.lock` file.

> Disclaimer: this project is partly vibe coded. The logic may contain mistakes, so review results before relying on them.

Related Bun issue: [Deduplicate / dedupe command for bun install #1343](https://github.com/oven-sh/bun/issues/1343)

## Usage

Run in any directory with a `bun.lock` file:

```bash
bunx bunlock-dedupe          # show all duplicates
bunx bunlock-dedupe --fixable  # show only fixable duplicates
bunx bunlock-dedupe --fix    # rewrite the lockfile
```

Or pass a path to a lockfile or project directory:

```bash
bunx bunlock-dedupe /path/to/bun.lock
bunx bunlock-dedupe /path/to/bun.lock --fixable
bunx bunlock-dedupe /path/to/bun.lock --fix
```

## What each mode does

**No flags** — scans the lockfile and lists every package that appears in more than one version. For each, it shows the package name, the versions found, and the full dependency path that pulled in each version (so you can see which package required what).

**`--fixable`** — same scan, but only shows packages where deduplication is actually possible. Marks the version that would be kept (`✅`) and the versions that can be upgraded to it (`⬆️`).

**`--fix`** — rewrites the lockfile, upgrading every dedupe-compatible version to the highest version that all their semver ranges allow.

## How deduplication works

Bun sometimes resolves the same package at multiple versions because different packages declare different version ranges — even ranges that could be satisfied by the same version.

For example, if package A requires `^3.15.2` and package B requires `^3.17.0`, both ranges are compatible with `3.17.0`. `--fix` upgrades the `^3.15.2` entry to `3.17.0`, removing the duplicate.
