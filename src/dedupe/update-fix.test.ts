import { describe, expect, test } from "bun:test"

import type { PackageMetadata } from "../registry"
import { updateAndDedupeLockText } from "./update-fix"

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

function makeRegistry(
  versionsByPackage: Record<string, string[]>,
  metadataByPackageVersion: Record<string, Record<string, PackageMetadata>>,
): FetchFn {
  return async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString()
    const path = url.slice("https://registry.npmjs.org/".length)
    const decoded = decodeURIComponent(path)
    const slashIdx = decoded.startsWith("@")
      ? decoded.indexOf("/", decoded.indexOf("/") + 1)
      : decoded.indexOf("/")

    if (slashIdx === -1) {
      const versions = versionsByPackage[decoded]
      if (!versions) return new Response(null, { status: 404 })

      return new Response(
        JSON.stringify({
          versions: Object.fromEntries(
            versions.map((version) => [version, {}]),
          ),
        }),
        { status: 200 },
      )
    }

    const pkgName = decoded.slice(0, slashIdx)
    const version = decoded.slice(slashIdx + 1)
    const meta = metadataByPackageVersion[pkgName]?.[version]
    if (!meta) return new Response(null, { status: 404 })

    return new Response(JSON.stringify(meta), { status: 200 })
  }
}

describe("updateAndDedupeLockText", () => {
  test("updates intermediate packages and then dedupes unlocked nested deps", async () => {
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "myapp",
      "dependencies": {
        "app-blocking": "^1.0.0",
        "shared-dep": "^2.0.0"
      }
    }
  },
  "packages": {
    "app-blocking": ["app-blocking@1.0.0", "", { "dependencies": { "shared-dep": "^1.0.0" } }, "sha-old"],

    "app-blocking/shared-dep": ["shared-dep@1.5.0", "", {}, "sha-nested"],

    "shared-dep": ["shared-dep@2.1.0", "", {}, "sha-root"]
  }
}
`

    const result = await updateAndDedupeLockText(lockText, {
      fetchFn: makeRegistry(
        { "app-blocking": ["1.0.0", "1.1.0"] },
        {
          "app-blocking": {
            "1.1.0": {
              version: "1.1.0",
              dependencies: { "shared-dep": "^2.0.0" },
              bin: { "app-blocking": "bin.js" },
              dist: { integrity: "sha-new" },
            },
          },
        },
      ),
    })

    expect(result.changed).toBe(true)
    expect(result.updatedEntries).toBe(1)
    expect(result.updatedPackages).toBe(1)
    expect(result.dedupedEntries).toBe(1)
    expect(result.dedupedPackages).toBe(1)
    expect(result.appliedUpdates).toHaveLength(1)
    expect(result.skippedUpdates).toHaveLength(0)
    expect(result.lockText).toContain(
      `"app-blocking": ["app-blocking@1.1.0", "", { "dependencies": { "shared-dep": "^2.0.0" }, "bin": { "app-blocking": "bin.js" } }, "sha-new"]`,
    )
    expect(result.lockText).not.toContain("app-blocking/shared-dep")
  })

  test("converts npm optional peer metadata to bun optionalPeers", async () => {
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "myapp",
      "dependencies": {
        "app-blocking": "^1.0.0",
        "shared-dep": "^2.0.0"
      }
    }
  },
  "packages": {
    "app-blocking": ["app-blocking@1.0.0", "", { "dependencies": { "shared-dep": "^1.0.0" } }, "sha-old"],

    "app-blocking/shared-dep": ["shared-dep@1.5.0", "", {}, "sha-nested"],

    "shared-dep": ["shared-dep@2.1.0", "", {}, "sha-root"]
  }
}
`

    const result = await updateAndDedupeLockText(lockText, {
      fetchFn: makeRegistry(
        { "app-blocking": ["1.0.0", "1.1.0"] },
        {
          "app-blocking": {
            "1.1.0": {
              version: "1.1.0",
              dependencies: { "shared-dep": "^2.0.0" },
              peerDependencies: { "optional-tool": "*" },
              peerDependenciesMeta: {
                "optional-tool": { optional: true },
              },
              dist: { integrity: "sha-new" },
            },
          },
        },
      ),
    })

    expect(result.changed).toBe(true)
    expect(result.lockText).toContain(
      `"peerDependencies": { "optional-tool": "*" }, "optionalPeers": ["optional-tool"]`,
    )
  })

  test("skips update metadata without integrity instead of reusing stale integrity", async () => {
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "myapp",
      "dependencies": {
        "app-blocking": "^1.0.0",
        "shared-dep": "^2.0.0"
      }
    }
  },
  "packages": {
    "app-blocking": ["app-blocking@1.0.0", "", { "dependencies": { "shared-dep": "^1.0.0" } }, "sha-old"],

    "app-blocking/shared-dep": ["shared-dep@1.5.0", "", {}, "sha-nested"],

    "shared-dep": ["shared-dep@2.1.0", "", {}, "sha-root"]
  }
}
`

    const result = await updateAndDedupeLockText(lockText, {
      fetchFn: makeRegistry(
        { "app-blocking": ["1.0.0", "1.1.0"] },
        {
          "app-blocking": {
            "1.1.0": {
              version: "1.1.0",
              dependencies: { "shared-dep": "^2.0.0" },
            },
          },
        },
      ),
    })

    expect(result.changed).toBe(false)
    expect(result.updatedEntries).toBe(0)
    expect(result.dedupedEntries).toBe(0)
    expect(result.appliedUpdates).toHaveLength(0)
    expect(result.skippedUpdates).toHaveLength(1)
    expect(result.lockText).toBe(lockText)
  })

  test("skips updates that introduce missing runtime dependencies", async () => {
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "myapp",
      "dependencies": {
        "app-blocking": "^1.0.0",
        "shared-dep": "^2.0.0"
      }
    }
  },
  "packages": {
    "app-blocking": ["app-blocking@1.0.0", "", { "dependencies": { "shared-dep": "^1.0.0" } }, "sha-old"],

    "app-blocking/shared-dep": ["shared-dep@1.5.0", "", {}, "sha-nested"],

    "shared-dep": ["shared-dep@2.1.0", "", {}, "sha-root"]
  }
}
`

    const result = await updateAndDedupeLockText(lockText, {
      fetchFn: makeRegistry(
        { "app-blocking": ["1.0.0", "1.1.0"] },
        {
          "app-blocking": {
            "1.1.0": {
              version: "1.1.0",
              dependencies: {
                "new-runtime-dep": "^1.0.0",
                "shared-dep": "^2.0.0",
              },
              dist: { integrity: "sha-new" },
            },
          },
        },
      ),
    })

    expect(result.changed).toBe(false)
    expect(result.updatedEntries).toBe(0)
    expect(result.dedupedEntries).toBe(0)
    expect(result.lockText).toBe(lockText)
  })

  test("skips updates that introduce missing non-optional peer dependencies", async () => {
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "myapp",
      "dependencies": {
        "app-blocking": "^1.0.0",
        "shared-dep": "^2.0.0"
      }
    }
  },
  "packages": {
    "app-blocking": ["app-blocking@1.0.0", "", { "dependencies": { "shared-dep": "^1.0.0" } }, "sha-old"],

    "app-blocking/shared-dep": ["shared-dep@1.5.0", "", {}, "sha-nested"],

    "shared-dep": ["shared-dep@2.1.0", "", {}, "sha-root"]
  }
}
`

    const result = await updateAndDedupeLockText(lockText, {
      fetchFn: makeRegistry(
        { "app-blocking": ["1.0.0", "1.1.0"] },
        {
          "app-blocking": {
            "1.1.0": {
              version: "1.1.0",
              dependencies: { "shared-dep": "^2.0.0" },
              peerDependencies: { "missing-peer": "^1.0.0" },
              dist: { integrity: "sha-new" },
            },
          },
        },
      ),
    })

    expect(result.changed).toBe(false)
    expect(result.updatedEntries).toBe(0)
    expect(result.dedupedEntries).toBe(0)
    expect(result.appliedUpdates).toHaveLength(0)
    expect(result.skippedUpdates).toHaveLength(1)
    expect(result.lockText).toBe(lockText)
  })
})
