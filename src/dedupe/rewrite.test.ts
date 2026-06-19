import { describe, expect, test } from "bun:test"

import { analyzeDuplicatePackages } from "./analyze"
import { parseBunLock } from "./parse"
import { dedupeLockText } from "./rewrite"

describe("dedupeLockText", () => {
  test("keeps deduping until no newly unlocked fixes remain", () => {
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "example",
      "dependencies": {
        "app": "1.0.0",
        "other": "1.0.0",
        "leaf": "2.0.0"
      }
    }
  },
  "packages": {
    "app": ["app@1.0.0", "", { "dependencies": { "mid": ">=1.0.0" } }, "sha"],

    "app/mid": ["mid@1.0.0", "", { "dependencies": { "leaf": "^1.0.0" } }, "sha"],

    "app/mid/leaf": ["leaf@1.0.0", "", {}, "sha"],

    "other": ["other@1.0.0", "", { "dependencies": { "mid": "^2.0.0" } }, "sha"],

    "other/mid": ["mid@2.0.0", "", { "dependencies": { "leaf": "^2.0.0" } }, "sha"],

    "leaf": ["leaf@2.0.0", "", {}, "sha"]
  }
}
`

    const result = dedupeLockText(lockText)
    const duplicates = analyzeDuplicatePackages(parseBunLock(result.lockText))

    expect(result.changed).toBe(true)
    expect(result.lockText).not.toContain("app/mid/leaf")
    expect(
      duplicates.flatMap((duplicate) =>
        duplicate.versions.filter((version) => version.status === "can-dedupe"),
      ),
    ).toHaveLength(0)
  })

  test("prunes stale entries that become unreachable after a rewrite", () => {
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "example",
      "dependencies": {
        "app": "1.0.0",
        "shared": "^2.0.0"
      }
    }
  },
  "packages": {
    "app": ["app@1.0.0", "", { "dependencies": { "shared": ">=1.0.0" } }, "sha"],

    "app/shared": ["shared@1.0.0", "", {}, "sha"],

    "shared": ["shared@2.0.0", "", {}, "sha"],

    "stale": ["stale@1.0.0", "", { "dependencies": { "stale-leaf": "1.0.0" } }, "sha"],

    "stale-leaf": ["stale-leaf@1.0.0", "", {}, "sha"]
  }
}
`

    const result = dedupeLockText(lockText)

    expect(result.changed).toBe(true)
    expect(result.lockText).not.toContain('"app/shared"')
    expect(result.lockText).not.toContain('"stale"')
    expect(result.lockText).not.toContain('"stale-leaf"')
  })

  test("does not copy bundled markers out of their original context", () => {
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "example",
      "dependencies": {
        "bundler": "1.0.0",
        "native": ">=1.0.0"
      }
    }
  },
  "packages": {
    "bundler": ["bundler@1.0.0", "", { "dependencies": { "native": "^2.0.0" } }, "sha"],

    "bundler/native": ["native@2.0.0", "", { "bundled": true }, "sha"],

    "native": ["native@1.0.0", "", {}, "sha"]
  }
}
`

    const result = dedupeLockText(lockText)
    const lock = parseBunLock(result.lockText)

    expect(result.changed).toBe(true)
    expect(lock.packages?.native?.[2]).toEqual({})
    expect(lock.packages?.["bundler/native"]?.[2]).toEqual({ bundled: true })
  })

  test("preserves original bun.lock key order without parasitic reordering", () => {
    // Bun does not sort package keys by a stable comparator; it emits them in
    // resolution order. Re-sorting (e.g. by nesting depth then segments)
    // produces parasitic diffs. Two cases that NO single comparator can keep
    // both correct, so we must preserve input order verbatim:
    //   depth 1: "@scope/parent/..." before "@scope/parent-kit/..."
    //   depth 2: "@scope/parent-kit/.../leaf" before "@scope/parent/.../leaf"
    // A real dedupe happens elsewhere ("useful/lib" -> root "lib") to exercise
    // the rewrite + render path.
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "example",
      "dependencies": {
        "@scope/parent": "1.0.0",
        "@scope/parent-kit": "1.0.0",
        "useful": "1.0.0",
        "lib": "^2.0.0"
      }
    }
  },
  "packages": {
    "@scope/parent": ["@scope/parent@1.0.0", "", { "dependencies": { "@scope/mid": "1.0.0" } }, "sha"],

    "@scope/parent/@scope/mid": ["@scope/mid@1.0.0", "", { "dependencies": { "leaf": "1.0.0" } }, "sha"],

    "@scope/parent-kit": ["@scope/parent-kit@1.0.0", "", { "dependencies": { "@scope/mid": "1.0.0" } }, "sha"],

    "@scope/parent-kit/@scope/mid": ["@scope/mid@1.0.0", "", { "dependencies": { "leaf": "1.0.0" } }, "sha"],

    "@scope/parent-kit/@scope/mid/leaf": ["leaf@1.0.0", "", {}, "sha"],

    "@scope/parent/@scope/mid/leaf": ["leaf@1.0.0", "", {}, "sha"],

    "useful": ["useful@1.0.0", "", { "dependencies": { "lib": ">=1.0.0" } }, "sha"],

    "useful/lib": ["lib@1.0.0", "", {}, "sha"],

    "lib": ["lib@2.0.0", "", {}, "sha"]
  }
}
`

    const result = dedupeLockText(lockText)
    const lock = parseBunLock(result.lockText)

    expect(result.changed).toBe(true)
    expect(result.lockText).not.toContain('"useful/lib"')
    // Surviving keys keep their exact input relative order — no re-sort.
    expect(Object.keys(lock.packages ?? {})).toEqual([
      "@scope/parent",
      "@scope/parent/@scope/mid",
      "@scope/parent-kit",
      "@scope/parent-kit/@scope/mid",
      "@scope/parent-kit/@scope/mid/leaf",
      "@scope/parent/@scope/mid/leaf",
      "useful",
      "lib",
    ])
  })
})
