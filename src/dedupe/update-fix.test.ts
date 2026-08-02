import { describe, expect, test } from "bun:test"

import type { PackageMetadata } from "../registry"
import { analyzeDuplicatePackages } from "./analyze"
import { parseBunLock } from "./parse"
import { classifyUpdateSafety, updateAndDedupeLockText } from "./update-fix"

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

    if (slashIdx !== -1) {
      // Packument requests must hit the package root, not a per-version URL.
      return new Response(null, { status: 404 })
    }

    const pkgName = decoded
    const versions = versionsByPackage[pkgName]
    if (!versions) return new Response(null, { status: 404 })

    const versionsObj: Record<string, PackageMetadata> = {}
    for (const version of versions) {
      versionsObj[version] = metadataByPackageVersion[pkgName]?.[version] ?? {
        version,
      }
    }
    return new Response(JSON.stringify({ versions: versionsObj }), {
      status: 200,
    })
  }
}

describe("classifyUpdateSafety", () => {
  test("rejects normal dependency ranges that resolve to prereleases", async () => {
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "myapp",
      "dependencies": {
        "app-blocking": "^1.0.0",
        "tool": "2.0.0"
      }
    }
  },
  "packages": {
    "app-blocking": ["app-blocking@1.0.0", "", {}, "sha-old"],

    "app-blocking/tool": ["tool@2.1.0-beta.0", "", {}, "sha-beta"],

    "tool": ["tool@2.0.0", "", {}, "sha-stable"]
  }
}
`

    const update = {
      requesterLockKey: "app-blocking",
      packageName: "app-blocking",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      deduplicates: [],
      constrainedBy: [],
    }
    const result = await classifyUpdateSafety(lockText, [update], {
      fetchFn: makeRegistry(
        { "app-blocking": ["1.1.0"] },
        {
          "app-blocking": {
            "1.1.0": {
              version: "1.1.0",
              dependencies: { tool: "^2.0.0" },
              dist: { integrity: "sha-new" },
            },
          },
        },
      ),
    })

    expect(result.applicableUpdates).toEqual([])
    expect(result.skippedUpdates).toEqual([
      { ...update, skipReason: "dependency-conflict" },
    ])
  })
})

describe("updateAndDedupeLockText", () => {
  test("orders metadata created from an update like bun install", async () => {
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "myapp",
      "dependencies": {
        "app-blocking": "^1.0.0",
        "shared-dep": "^2.0.0",
        "@scope/alpha": "^1.0.0",
        "optional-a": "^1.0.0",
        "optional-z": "^1.0.0",
        "peer-a": "^1.0.0",
        "peer-z": "^1.0.0",
        "zeta": "^1.0.0"
      }
    }
  },
  "packages": {
    "app-blocking": ["app-blocking@1.0.0", "", { "dependencies": { "shared-dep": "^1.0.0" } }, "sha-old"],

    "app-blocking/shared-dep": ["shared-dep@1.5.0", "", {}, "sha-nested"],

    "shared-dep": ["shared-dep@2.1.0", "", {}, "sha-root"],

    "@scope/alpha": ["@scope/alpha@1.0.0", "", {}, "sha"],

    "optional-a": ["optional-a@1.0.0", "", {}, "sha"],

    "optional-z": ["optional-z@1.0.0", "", {}, "sha"],

    "peer-a": ["peer-a@1.0.0", "", {}, "sha"],

    "peer-z": ["peer-z@1.0.0", "", {}, "sha"],

    "zeta": ["zeta@1.0.0", "", {}, "sha"]
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
                zeta: "^1.0.0",
                "@scope/alpha": "^1.0.0",
                "shared-dep": "^2.0.0",
              },
              optionalDependencies: {
                "optional-z": "^1.0.0",
                "optional-a": "^1.0.0",
              },
              peerDependencies: {
                "peer-z": "^1.0.0",
                "peer-a": "^1.0.0",
              },
              peerDependenciesMeta: {
                "optional-peer-z": { optional: true },
                "optional-peer-a": { optional: true },
              },
              bin: { zebra: "zebra.js", alpha: "alpha.js" },
              os: ["win32", "darwin"],
              cpu: ["x64", "arm64"],
              dist: { integrity: "sha-new" },
            },
          },
        },
      ),
    })

    expect(result.lockText).toContain(
      `"app-blocking": ["app-blocking@1.1.0", "", { "dependencies": { "@scope/alpha": "^1.0.0", "shared-dep": "^2.0.0", "zeta": "^1.0.0" }, "optionalDependencies": { "optional-a": "^1.0.0", "optional-z": "^1.0.0" }, "peerDependencies": { "peer-a": "^1.0.0", "peer-z": "^1.0.0" }, "optionalPeers": ["optional-peer-z", "optional-peer-a"], "bin": { "zebra": "zebra.js", "alpha": "alpha.js" }, "os": ["win32", "darwin"], "cpu": ["x64", "arm64"] }, "sha-new"]`,
    )
  })

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
    // The written lockfile must resolve every dependency consistently: a fresh
    // analysis of the final text should find nothing left to dedupe.
    expect(analyzeDuplicatePackages(parseBunLock(result.lockText))).toEqual([])
  })

  test("skips updates whose new dependency range resolves to an incompatible version", async () => {
    // `util@2.0.0` exists in the lockfile, but only nested under `util-parent`.
    // From `app-blocking` the name `util` resolves to the root `util@1.0.0`,
    // which the updated metadata's exact pin `2.0.0` does not accept — so the
    // update must be skipped even though a compatible entry exists globally.
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "myapp",
      "dependencies": {
        "app-blocking": "^1.0.0",
        "exact-parent": "^1.0.0",
        "shared-dep": "^2.0.0",
        "util-parent": "^1.0.0"
      }
    }
  },
  "packages": {
    "app-blocking": ["app-blocking@1.0.0", "", { "dependencies": { "shared-dep": "^1.0.0" } }, "sha-old"],

    "app-blocking/shared-dep": ["shared-dep@1.5.0", "", {}, "sha-nested"],

    "shared-dep": ["shared-dep@2.1.0", "", {}, "sha-root"],

    "exact-parent": ["exact-parent@1.0.0", "", { "dependencies": { "util": "1.0.0" } }, "sha"],

    "util": ["util@1.0.0", "", {}, "sha-util-1"],

    "util-parent": ["util-parent@1.0.0", "", { "dependencies": { "util": "2.0.0" } }, "sha"],

    "util-parent/util": ["util@2.0.0", "", {}, "sha-util-2"]
  }
}
`

    const result = await updateAndDedupeLockText(lockText, {
      fetchFn: makeRegistry(
        {
          "app-blocking": ["1.0.0", "1.1.0"],
          "exact-parent": ["1.0.0"],
        },
        {
          "app-blocking": {
            "1.1.0": {
              version: "1.1.0",
              dependencies: {
                "shared-dep": "^2.0.0",
                util: "2.0.0",
              },
              dist: { integrity: "sha-new" },
            },
          },
        },
      ),
    })

    expect(result.changed).toBe(false)
    expect(result.updatedEntries).toBe(0)
    expect(result.appliedUpdates).toHaveLength(0)
    expect(result.skippedUpdates).toEqual([
      expect.objectContaining({
        packageName: "app-blocking",
        toVersion: "1.1.0",
        skipReason: "dependency-conflict",
      }),
    ])
    expect(result.lockText).toBe(lockText)
  })

  test("skips an update when a co-blocked duplicate keeps its incompatible nested version", async () => {
    // `dup-free` would dedupe after the update, but `dup-pinned` stays at
    // 1.0.0 because `pinned-parent` pins it and has no newer version. The
    // updated `app-blocking` would then request `dup-pinned@2.0.0` while its
    // nested entry still resolves to 1.0.0 — the update must not be written.
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "myapp",
      "dependencies": {
        "app-blocking": "^1.0.0",
        "dup-free": "^2.0.0",
        "dup-pinned": "^2.0.0",
        "pinned-parent": "^1.0.0"
      }
    }
  },
  "packages": {
    "app-blocking": ["app-blocking@1.0.0", "", { "dependencies": { "dup-free": "1.0.0", "dup-pinned": "1.0.0" } }, "sha-old"],

    "app-blocking/dup-free": ["dup-free@1.0.0", "", {}, "sha"],

    "app-blocking/dup-pinned": ["dup-pinned@1.0.0", "", {}, "sha"],

    "pinned-parent": ["pinned-parent@1.0.0", "", { "dependencies": { "dup-pinned": "1.0.0" } }, "sha"],

    "pinned-parent/dup-pinned": ["dup-pinned@1.0.0", "", {}, "sha"],

    "dup-free": ["dup-free@2.0.0", "", {}, "sha"],

    "dup-pinned": ["dup-pinned@2.0.0", "", {}, "sha"]
  }
}
`

    const result = await updateAndDedupeLockText(lockText, {
      fetchFn: makeRegistry(
        {
          "app-blocking": ["1.0.0", "1.1.0"],
          "pinned-parent": ["1.0.0"],
        },
        {
          "app-blocking": {
            "1.1.0": {
              version: "1.1.0",
              dependencies: { "dup-free": "2.0.0", "dup-pinned": "2.0.0" },
              dist: { integrity: "sha-new" },
            },
          },
        },
      ),
    })

    expect(result.changed).toBe(false)
    expect(result.appliedUpdates).toHaveLength(0)
    expect(result.skippedUpdates).toEqual([
      expect.objectContaining({
        packageName: "app-blocking",
        skipReason: "dependency-conflict",
      }),
    ])
    expect(result.lockText).toBe(lockText)
  })

  test("applies nothing when a co-blocker without updates pins the duplicate", async () => {
    // The vue-tsc/@golar/vue regression: the target version exists only in a
    // foreign nested entry and `pinned-parent` (no newer version) pins the
    // root duplicate, so updating `app-blocking` is suggested by nothing and
    // the lockfile must stay untouched.
    const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "myapp",
      "dependencies": {
        "app-blocking": "^1.0.0",
        "other-parent": "^1.0.0",
        "pinned-parent": "^1.0.0"
      }
    }
  },
  "packages": {
    "app-blocking": ["app-blocking@1.0.0", "", { "dependencies": { "shared-dep": "2.0.0" } }, "sha"],

    "pinned-parent": ["pinned-parent@1.0.0", "", { "dependencies": { "shared-dep": "2.0.0" } }, "sha"],

    "other-parent": ["other-parent@1.0.0", "", { "dependencies": { "shared-dep": "3.0.0" } }, "sha"],

    "other-parent/shared-dep": ["shared-dep@3.0.0", "", {}, "sha3"],

    "shared-dep": ["shared-dep@2.0.0", "", {}, "sha2"]
  }
}
`

    const result = await updateAndDedupeLockText(lockText, {
      fetchFn: makeRegistry(
        {
          "app-blocking": ["1.0.0", "1.1.0"],
          "pinned-parent": ["1.0.0"],
        },
        {
          "app-blocking": {
            "1.1.0": {
              version: "1.1.0",
              dependencies: { "shared-dep": "3.0.0" },
              dist: { integrity: "sha-new" },
            },
          },
        },
      ),
    })

    expect(result.changed).toBe(false)
    expect(result.suggestedUpdates).toEqual([])
    expect(result.skippedUpdates).toEqual([])
    expect(result.lockText).toBe(lockText)
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
