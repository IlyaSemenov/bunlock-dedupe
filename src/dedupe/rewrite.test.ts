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
})
