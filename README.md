# bunlock-dedupe

`bunlock-dedupe` is a tool for analyzing and deduplicating `bun.lock` sub-dependencies.

> Disclaimer: this project is partly vibe coded. The logic may contain mistakes, so review results before relying on them.

## Usage

Run in the project directory that contains a `bun.lock` file:

```bash
bunx bunlock-dedupe
bunx bunlock-dedupe --fixable
bunx bunlock-dedupe --fix
```

You can pass a custom lockfile path (or a project directory) as an optional argument:

```bash
bunx bunlock-dedupe /path/to/bun.lock
bunx bunlock-dedupe /path/to/bun.lock --fixable
bunx bunlock-dedupe /path/to/bun.lock --fix
```

## Default behavior

`bunlock-dedupe` parses `bun.lock` in the current directory and reports duplicate
libraries (the same package name resolved in multiple versions).

For each duplicate group, it prints:

- package name
- each resolved version
- full dependency path from root package name to the requester, with the requester range

With `--fixable`, it only prints:

- packages that have at least one dedupe-compatible version
- target versions (`✅`) and dedupe-compatible versions (`⬆️`)

## What `--fix` does

`bunlock-dedupe --fix` reads `bun.lock`, analyzes duplicate package versions, and rewrites
dedupe-compatible entries to a selected target version.

It targets cases where semver ranges allow upgrading a lower resolved sub-dependency
to an already present higher version.

## Example

Two ranges can resolve to the same version:

- `^3.17.0`
- `^3.15.2`

If both can be satisfied by `3.17.0`, `bunlock-dedupe --fix` rewrites lockfile entries
to use that target resolution.
