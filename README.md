# bunlock-dedupe

`bunlock-dedupe` finds and fixes duplicate package versions in your `bun.lock` file.

> Disclaimer: this project is partly vibe coded. The logic may contain mistakes, so review results before relying on them.

Related Bun issue: [Deduplicate / dedupe command for bun install #1343](https://github.com/oven-sh/bun/issues/1343)

## Usage

Run in any directory with a `bun.lock` file:

```bash
bunx bunlock-dedupe                     # show all duplicates
bunx bunlock-dedupe --fixable           # show only fixable duplicates
bunx bunlock-dedupe --fix               # rewrite the lockfile
bunx bunlock-dedupe --update            # find updates that unlock deduplication
bunx bunlock-dedupe --update --fix      # apply those updates and dedupe
bunx bunlock-dedupe --update --offline  # analyze using only the local bun cache
```

Or pass a path to a lockfile or project directory:

```bash
bunx bunlock-dedupe /path/to/bun.lock
bunx bunlock-dedupe /path/to/bun.lock --fix
```

## What each mode does

**No flags** — scans the lockfile and lists every package that appears in more than one version. For each, it shows the package name, the versions found, and the full dependency path that pulled in each version (so you can see which package required what).

**`--fixable`** — same scan, but only shows packages where deduplication is actually possible. Marks the version that will be kept (`✅`), the versions that can be upgraded to it (`⬆️`), and orphan versions (`🗑️`) that will be removed when the parent is deduped.

**`--fix`** — rewrites the lockfile, upgrading every dedupe-compatible version to the highest version that all their semver ranges allow.

**`--update`** — scans for intermediate dependencies that block deduplication and checks the npm registry for newer compatible versions that would unlock it.
Use `--update --fix` to apply suggested lockfile updates and dedupe the unlocked entries.
Use `--offline` to analyze only the local bun cache instead of the registry. `--offline --fix` is intentionally rejected because Bun's package cache does not include registry integrity metadata needed to safely write updated lockfile entries.

## Output explained

Each duplicate package is listed with its versions. Here is what every status means:

```text
typescript
  ✅ 5.8.3
    - myapp: ^5.8.0
  ⬆️ 5.6.2 → 5.8.3
    - myapp > ts-jest: ^5.6.0

react
  ✅ 19.1.0
    - myapp: ^19.0.0
  ❌ 18.3.1
    - myapp > react-pdf: ^18.0.0

@types/node
  ✅ 22.13.0
    - myapp: ^22.0.0
  ⬆️ 20.18.0 → 22.13.0
    - myapp > bun-types: *

undici-types
  ✅ 7.16.0
    - myapp > @types/node: ~7.16.0
  🗑️ 5.28.5
    - myapp > bun-types > @types/node ⬆️: ~5.26.0
```

| Icon | Meaning |
| ---- | ------- |
| ✅ | **Target** — the version that will be kept |
| ⬆️ | **Can dedupe** — can be upgraded to the target; `--fix` will do this automatically |
| ❌ | **Cannot dedupe** — requires a version incompatible with the target; needs manual resolution |
| 🗑️ | **Orphan** — will become unreachable once its parent (marked ⬆️ in the path) is deduped; no action needed |
| ❓ | **Unknown** — uses a non-semver range (e.g. `catalog:`, `workspace:`) that cannot be checked automatically |

## How deduplication works

Bun sometimes resolves the same package at multiple versions because different packages declare different version ranges — even ranges that could be satisfied by the same version.

For example, if package A requires `^3.15.2` and package B requires `^3.17.0`, both ranges are compatible with `3.17.0`. `--fix` upgrades the `^3.15.2` entry to `3.17.0`, removing the duplicate.

## Finding updates that unlock deduplication

When an intermediate dependency pins a subdependency to an older version (marked `❌ cannot-dedupe`), `--update` checks the npm registry for newer versions of that intermediate package that could break the deadlock.

```bash
bunlock-dedupe --update
```

```text
shared-dep
  ✅ 2.1.0
    - myapp: ^2.0.0
  🗑️ 1.5.0
    - myapp > app-blocking ⬆️: ^1.0.0

app-blocking
  ⬆️ 1.0.0 → 1.1.0
    - myapp: ^1.0.0
  👉 shared-dep: 1.5.0 → 2.1.0

Found 1 duplicate package in /project/bun.lock, 1 intermediate package can be updated to unlock deduplication.
```

Each suggestion shows the package to update, the version bump, the inbound ranges that allow that update, and which locked dependency versions would be deduped after the update.
