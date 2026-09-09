import { describe, expect, test } from "bun:test"

import { parseBunLock } from "../bunlock"
import type { PackageMetadata } from "../registry"
import { RegistryError } from "../registry"
import { repairLockText } from "./restore"

const original = JSON.stringify({
  packages: {
    pkg: [
      "pkg@1.0.0",
      "",
      { peerDependencies: { vue: "3.5.21" } },
      "sha512-pkg",
    ],
    vue: ["vue@3.5.21", "", {}, "sha512-vue"],
  },
})

function fetchMetadata(metadata: unknown) {
  return async (input: string | URL | Request) =>
    new Response(
      JSON.stringify({
        versions: String(input).endsWith("/vue")
          ? {
              "3.5.21": {
                version: "3.5.21",
                dist: { integrity: "sha512-vue" },
              },
            }
          : { "1.0.0": metadata },
      }),
    )
}

describe("repair source verification", () => {
  test.each([
    [null, "metadata-unavailable"],
    [
      { version: "2.0.0", dist: { integrity: "sha512-pkg" } },
      "invalid-metadata",
    ],
    [
      {
        version: "1.0.0",
        peerDependencies: { vue: 3 },
        dist: { integrity: "sha512-pkg" },
      },
      "invalid-metadata",
    ],
    [
      {
        version: "1.0.0",
        peerDependenciesMeta: { vue: { optional: "yes" } },
        dist: { integrity: "sha512-pkg" },
      },
      "invalid-metadata",
    ],
    [{ version: "1.0.0" }, "no-integrity"],
    [
      { version: "1.0.0", dist: { integrity: "sha512-other" } },
      "integrity-mismatch",
    ],
  ] as const)("keeps the original text when metadata %j cannot be trusted", async (metadata, reason) => {
    const result = await repairLockText(original, {
      fetchFn: fetchMetadata(metadata),
    })
    expect(result.lockText).toBe(original)
    expect(result.changed).toBe(false)
    expect(result.skippedEntries).toEqual([{ lockKey: "pkg", reason }])
  })

  test("supports lockfiles with SHA-1 archive identity", async () => {
    const shasum = "a".repeat(40)
    const integrity = `sha1-${Buffer.from(shasum, "hex").toString("base64")}`
    const lock = original.replace("sha512-pkg", integrity)
    const result = await repairLockText(lock, {
      fetchFn: fetchMetadata({
        version: "1.0.0",
        peerDependencies: { vue: "^3.5.0" },
        dist: { shasum },
      }),
    })
    expect(result.changed).toBe(true)
    expect(parseBunLock(result.lockText).packages?.pkg?.[3]).toBe(integrity)
  })

  test("does not query patched, workspace, or git entries", async () => {
    const lock = JSON.stringify({
      patchedDependencies: { "pkg@1.0.0": "patches/pkg.patch" },
      packages: {
        pkg: [
          "pkg@1.0.0",
          "",
          { peerDependencies: { vue: "3.5.21" } },
          "sha512-pkg",
        ],
        local: ["local@workspace:packages/local"],
        git: [
          "git@github:owner/repo#abcdef",
          { peerDependencies: { vue: "3.5.21" } },
          "cache",
        ],
      },
    })
    let calls = 0
    const result = await repairLockText(lock, {
      fetchFn: async () => {
        calls++
        throw new Error("Unexpected fetch")
      },
    })
    expect(calls).toBe(0)
    expect(result.lockText).toBe(lock)
    expect(result.skippedEntries).toEqual([
      { lockKey: "pkg", reason: "patched" },
      { lockKey: "git", reason: "not-registry" },
    ])
  })

  test("aborts on transient registry failure instead of returning a partial repair", async () => {
    await expect(
      repairLockText(original, {
        fetchFn: async () => new Response(null, { status: 503 }),
        retryDelayFn: async () => {},
      }),
    ).rejects.toBeInstanceOf(RegistryError)
  })
})

test("keeps the original text when the only repair requires a missing dependency", async () => {
  const result = await repairLockText(original, {
    fetchFn: fetchMetadata({
      version: "1.0.0",
      dependencies: { missing: "^1.0.0" },
      peerDependencies: { vue: "^3.5.0" },
      dist: { integrity: "sha512-pkg" },
    }),
  })
  expect(result.lockText).toBe(original)
  expect(result.changed).toBe(false)
  expect(result.repairedEntries).toEqual([])
  expect(result.conflicts).toEqual([])
  expect(result.skippedEntries).toEqual([
    {
      lockKey: "pkg",
      reason: "missing-dependencies",
      missingDependencies: ["missing"],
    },
  ])
})

test("fetches each package once, restores every locked version, and preserves context metadata", async () => {
  const lock = JSON.stringify({
    workspaces: { "": { dependencies: { pkg: "^2.0.0" } } },
    packages: {
      pkg: [
        "pkg@2.0.0",
        "custom-url",
        {
          peerDependencies: { vue: "3.5.21" },
          bin: "cli.js",
          cpu: ["arm64"],
          custom: true,
        },
        "sha512-new",
      ],
      "parent/pkg": [
        "pkg@1.0.0",
        "",
        { peerDependencies: { vue: "3.5.21" }, bundled: true },
        "sha512-old",
      ],
      "other/pkg": [
        "pkg@1.0.0",
        "",
        { peerDependencies: { vue: "3.5.21" } },
        "sha512-old",
      ],
      vue: ["vue@3.5.21", "", {}, "sha512-vue"],
    },
  })
  let calls = 0
  const versions: Record<string, PackageMetadata> = {
    "1.0.0": {
      version: "1.0.0",
      peerDependencies: { vue: "^3.5.0" },
      dist: { integrity: "sha512-old" },
    },
    "2.0.0": {
      version: "2.0.0",
      peerDependencies: { vue: "^3.5.0" },
      dist: { integrity: "sha512-new" },
    },
  }
  const result = await repairLockText(lock, {
    fetchFn: async (input) => {
      calls++
      if (String(input).endsWith("/vue")) return fetchMetadata(null)(input)
      return new Response(JSON.stringify({ versions }))
    },
  })
  expect(calls).toBe(2)
  expect(result.repairedEntries.map((entry) => entry.lockKey)).toEqual([
    "pkg",
    "parent/pkg",
    "other/pkg",
  ])
  const repaired = parseBunLock(result.lockText)
  expect(repaired.workspaces).toEqual(parseBunLock(lock).workspaces)
  expect(repaired.packages?.pkg as unknown).toEqual([
    "pkg@2.0.0",
    "custom-url",
    {
      peerDependencies: { vue: "^3.5.0" },
      bin: "cli.js",
      cpu: ["arm64"],
      custom: true,
    },
    "sha512-new",
  ])
  expect(repaired.packages?.["parent/pkg"]?.[2]).toEqual({
    peerDependencies: { vue: "^3.5.0" },
    bundled: true,
  })
})

test("ignores property order when published declarations already match", async () => {
  const lock = JSON.stringify({
    packages: {
      pkg: [
        "pkg@1.0.0",
        "",
        { peerDependencies: { z: "*", a: "*" }, optionalPeers: ["z", "a"] },
        "sha512-pkg",
      ],
    },
  })
  const result = await repairLockText(lock, {
    fetchFn: fetchMetadata({
      version: "1.0.0",
      peerDependencies: { a: "*", z: "*" },
      peerDependenciesMeta: { a: { optional: true }, z: { optional: true } },
      dist: { integrity: "sha512-pkg" },
    }),
  })
  expect(result.lockText).toBe(lock)
  expect(result.changed).toBe(false)
})
