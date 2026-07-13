import { describe, expect, test } from "bun:test"

import type { PackageMetadata } from "../registry"
import { formatDuplicatesReport } from "./format"
import type { BunLockFile, BunPackageEntry } from "./parse"
import { analyzeDuplicatePackagesWithUpdates } from "./update-analyze"

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

    if (!url.startsWith("https://registry.npmjs.org/")) {
      return new Response(null, { status: 404 })
    }

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

function lockWithCannotDedupe() {
  const packages: Record<string, BunPackageEntry> = {
    "app-blocking": [
      "app-blocking@1.0.0",
      "",
      { dependencies: { "shared-dep": "^1.0.0" } },
      "sha",
    ],
    "app-blocking/shared-dep": ["shared-dep@1.5.0", "", {}, "sha"],
    "shared-dep": ["shared-dep@2.1.0", "", {}, "sha"],
  }

  return {
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: {
      "": {
        name: "myapp",
        dependencies: {
          "app-blocking": "^1.0.0",
          "shared-dep": "^2.0.0",
        },
      },
    },
    packages,
  } satisfies BunLockFile
}

describe("analyzeDuplicatePackagesWithUpdates", () => {
  test("works in offline mode with cache mock", async () => {
    const lock = lockWithCannotDedupe()
    const cacheDir = "/fake/cache"

    const readDirFn = (path: string) => {
      if (path === "/fake/cache/app-blocking") {
        return ["1.0.0@@@1", "1.1.0@@@1"]
      }
      throw new Error(`ENOENT: ${path}`)
    }

    const readFileFn = (path: string) => {
      if (path === "/fake/cache/app-blocking/1.1.0@@@1/package.json") {
        return JSON.stringify({
          version: "1.1.0",
          dependencies: { "shared-dep": "^2.0.0" },
        })
      }
      throw new Error(`ENOENT: ${path}`)
    }

    const result = await analyzeDuplicatePackagesWithUpdates(lock, {
      offline: true,
      cacheDir,
      readDirFn,
      readFileFn,
    })

    expect(result.suggestedUpdates).toHaveLength(1)
    expect(result.suggestedUpdates[0]?.toVersion).toBe("1.1.0")
  })

  test("returns duplicates and update suggestions", async () => {
    const registry = makeRegistry(
      { "app-blocking": ["1.0.0", "1.1.0"] },
      {
        "app-blocking": {
          "1.1.0": {
            version: "1.1.0",
            dependencies: { "shared-dep": "^2.0.0" },
          },
        },
      },
    )

    const { duplicates, suggestedUpdates } =
      await analyzeDuplicatePackagesWithUpdates(lockWithCannotDedupe(), {
        fetchFn: registry,
      })

    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]?.name).toBe("shared-dep")
    expect(duplicates[0]?.targetVersion).toBe("2.1.0")
    expect(duplicates[0]?.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: "2.1.0", status: "target" }),
        expect.objectContaining({
          version: "1.5.0",
          status: "cannot-dedupe",
        }),
      ]),
    )

    expect(suggestedUpdates).toEqual([
      {
        requesterLockKey: "app-blocking",
        packageName: "app-blocking",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        deduplicates: [
          { name: "shared-dep", fromVersion: "1.5.0", targetVersion: "2.1.0" },
        ],
        constrainedBy: [
          {
            requesterLabel: "myapp (workspace)",
            requesterPath: ["myapp"],
            range: "^1.0.0",
          },
        ],
      },
    ])
  })

  test("keeps cannot-dedupe duplicates when an update suggestion exists", async () => {
    const registry = makeRegistry(
      { "app-blocking": ["1.0.0", "1.1.0"] },
      {
        "app-blocking": {
          "1.1.0": {
            version: "1.1.0",
            dependencies: { "shared-dep": "^2.0.0" },
          },
        },
      },
    )

    const { duplicates, suggestedUpdates } =
      await analyzeDuplicatePackagesWithUpdates(lockWithCannotDedupe(), {
        fetchFn: registry,
      })

    const blockedVersion = duplicates[0]?.versions.find(
      (version) => version.version === "1.5.0",
    )

    expect(blockedVersion?.status).toBe("cannot-dedupe")
    expect(blockedVersion?.requests).toEqual([
      expect.objectContaining({
        requesterNodeId: "app-blocking",
        dependencyName: "shared-dep",
        range: "^1.0.0",
        resolvedLockKey: "app-blocking/shared-dep",
      }),
    ])
    expect(suggestedUpdates).toHaveLength(1)
  })

  test("formats skipped update suggestions as requiring manual updates", async () => {
    const registry = makeRegistry(
      { "app-blocking": ["1.0.0", "1.1.0"] },
      {
        "app-blocking": {
          "1.1.0": {
            version: "1.1.0",
            dependencies: { "shared-dep": "^2.0.0" },
          },
        },
      },
    )

    const { duplicates, suggestedUpdates } =
      await analyzeDuplicatePackagesWithUpdates(lockWithCannotDedupe(), {
        fetchFn: registry,
      })

    const report = formatDuplicatesReport(duplicates, {
      includeUnfixable: false,
      suggestedUpdates,
      skippedUpdates: suggestedUpdates.map((update) => ({
        ...update,
        skipReason: "new-dependencies" as const,
      })),
    })
    expect(report).toContain("✋ 1.5.0 → 2.1.0")
    expect(report).toContain("can be removed after manual update:")
    expect(report).toContain("- app-blocking: 1.0.0 → 1.1.0")
    expect(report).toContain("required by:")
    expect(report).toContain("- myapp: ^1.0.0")
    expect(report).toContain(
      "held back: update adds dependencies missing from the lockfile",
    )
  })

  test("lists each requiredBy constraint on its own indented line", async () => {
    const registry = makeRegistry(
      { "app-blocking": ["1.0.0", "1.1.0"] },
      {
        "app-blocking": {
          "1.1.0": {
            version: "1.1.0",
            dependencies: { "shared-dep": "^2.0.0" },
          },
        },
      },
    )

    const { duplicates, suggestedUpdates } =
      await analyzeDuplicatePackagesWithUpdates(lockWithCannotDedupe(), {
        fetchFn: registry,
      })

    // Replace the single inbound constraint with several so the report has to
    // render more than one `required by` line.
    const skippedUpdates = suggestedUpdates.map((update) => ({
      ...update,
      skipReason: "new-dependencies" as const,
      constrainedBy: [
        { requesterLabel: "alpha", requesterPath: ["alpha"], range: "^1.0.0" },
        { requesterLabel: "beta", requesterPath: ["beta"], range: "^1.2.0" },
        {
          requesterLabel: "gamma",
          requesterPath: ["gamma > nested"],
          range: "^1.3.0",
        },
      ],
    }))

    const report = formatDuplicatesReport(duplicates, {
      includeUnfixable: false,
      suggestedUpdates,
      skippedUpdates,
    })

    expect(report).toContain("required by:\n")
    expect(report).toContain("          - alpha: ^1.0.0\n")
    expect(report).toContain("          - beta: ^1.2.0\n")
    expect(report).toContain("          - gamma > nested: ^1.3.0\n")
    // The list replaces the old single-line comma-joined form.
    expect(report).not.toContain("required by: alpha")
  })

  test("drops suggestions that cannot remove a duplicate pinned by a co-blocker", async () => {
    // Mirrors the vue-tsc/@golar/vue case: the duplicate's target version
    // exists only in foreign nested entries, and one of the two blockers has
    // no newer version, so updating the other blocker cannot dedupe anything.
    const packages: Record<string, BunPackageEntry> = {
      "app-blocking": [
        "app-blocking@1.0.0",
        "",
        { dependencies: { "shared-dep": "2.0.0" } },
        "sha",
      ],
      "pinned-parent": [
        "pinned-parent@1.0.0",
        "",
        { dependencies: { "shared-dep": "2.0.0" } },
        "sha",
      ],
      "other-parent": [
        "other-parent@1.0.0",
        "",
        { dependencies: { "shared-dep": "3.0.0" } },
        "sha",
      ],
      "other-parent/shared-dep": ["shared-dep@3.0.0", "", {}, "sha"],
      "shared-dep": ["shared-dep@2.0.0", "", {}, "sha"],
    }
    const lock = {
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: {
        "": {
          name: "myapp",
          dependencies: {
            "app-blocking": "^1.0.0",
            "other-parent": "^1.0.0",
            "pinned-parent": "^1.0.0",
          },
        },
      },
      packages,
    } satisfies BunLockFile

    const registry = makeRegistry(
      {
        "app-blocking": ["1.0.0", "1.1.0"],
        "pinned-parent": ["1.0.0"],
      },
      {
        "app-blocking": {
          "1.1.0": {
            version: "1.1.0",
            dependencies: { "shared-dep": "3.0.0" },
          },
        },
      },
    )

    const { suggestedUpdates } = await analyzeDuplicatePackagesWithUpdates(
      lock,
      { fetchFn: registry },
    )

    expect(suggestedUpdates).toEqual([])
  })

  test("keeps a suggestion but prunes co-blocked unlocks from its deduplicates", async () => {
    const packages: Record<string, BunPackageEntry> = {
      "app-blocking": [
        "app-blocking@1.0.0",
        "",
        { dependencies: { "dup-free": "1.0.0", "dup-pinned": "1.0.0" } },
        "sha",
      ],
      "app-blocking/dup-free": ["dup-free@1.0.0", "", {}, "sha"],
      "app-blocking/dup-pinned": ["dup-pinned@1.0.0", "", {}, "sha"],
      "pinned-parent": [
        "pinned-parent@1.0.0",
        "",
        { dependencies: { "dup-pinned": "1.0.0" } },
        "sha",
      ],
      "pinned-parent/dup-pinned": ["dup-pinned@1.0.0", "", {}, "sha"],
      "dup-free": ["dup-free@2.0.0", "", {}, "sha"],
      "dup-pinned": ["dup-pinned@2.0.0", "", {}, "sha"],
    }
    const lock = {
      lockfileVersion: 1,
      configVersion: 1,
      workspaces: {
        "": {
          name: "myapp",
          dependencies: {
            "app-blocking": "^1.0.0",
            "dup-free": "^2.0.0",
            "dup-pinned": "^2.0.0",
            "pinned-parent": "^1.0.0",
          },
        },
      },
      packages,
    } satisfies BunLockFile

    const registry = makeRegistry(
      {
        "app-blocking": ["1.0.0", "1.1.0"],
        "pinned-parent": ["1.0.0"],
      },
      {
        "app-blocking": {
          "1.1.0": {
            version: "1.1.0",
            dependencies: { "dup-free": "2.0.0", "dup-pinned": "2.0.0" },
          },
        },
      },
    )

    const { suggestedUpdates } = await analyzeDuplicatePackagesWithUpdates(
      lock,
      { fetchFn: registry },
    )

    expect(suggestedUpdates).toHaveLength(1)
    expect(suggestedUpdates[0]?.deduplicates).toEqual([
      { name: "dup-free", fromVersion: "1.0.0", targetVersion: "2.0.0" },
    ])
  })

  test("returns no suggestions when no compatible newer version exists", async () => {
    const registry = makeRegistry({ "app-blocking": ["1.0.0"] }, {})

    const { duplicates, suggestedUpdates } =
      await analyzeDuplicatePackagesWithUpdates(lockWithCannotDedupe(), {
        fetchFn: registry,
      })

    expect(duplicates).toHaveLength(1)
    expect(
      duplicates[0]?.versions.some(
        (version) => version.status === "cannot-dedupe",
      ),
    ).toBe(true)
    expect(suggestedUpdates).toEqual([])
  })

  test("reports analyze progress per processed requester", async () => {
    const registry = makeRegistry(
      { "app-blocking": ["1.0.0", "1.1.0"] },
      {
        "app-blocking": {
          "1.1.0": {
            version: "1.1.0",
            dependencies: { "shared-dep": "^2.0.0" },
          },
        },
      },
    )

    const events: { phase: string; current: number; total: number }[] = []
    await analyzeDuplicatePackagesWithUpdates(lockWithCannotDedupe(), {
      fetchFn: registry,
      onProgress: (p) =>
        events.push({ phase: p.phase, current: p.current, total: p.total }),
    })

    expect(events).toEqual([{ phase: "analyze", current: 1, total: 1 }])
  })
})
