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
    if (slashIdx === -1) {
      const pkgName = decoded
      const versions = versionsByPackage[pkgName]
      if (!versions) return new Response(null, { status: 404 })
      const versionsObj: Record<string, unknown> = {}
      for (const v of versions) versionsObj[v] = {}
      return new Response(JSON.stringify({ versions: versionsObj }), {
        status: 200,
      })
    }

    const pkgName = decoded.slice(0, slashIdx)
    const version = decoded.slice(slashIdx + 1)
    const meta = metadataByPackageVersion[pkgName]?.[version]
    if (!meta) return new Response(null, { status: 404 })
    return new Response(JSON.stringify(meta), { status: 200 })
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

    expect(
      formatDuplicatesReport(duplicates, {
        includeUnfixable: false,
        suggestedUpdates,
        skippedUpdates: suggestedUpdates,
      }),
    ).toContain("⏩ 1.0.0 → 1.1.0 (manual update required)")
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
})
