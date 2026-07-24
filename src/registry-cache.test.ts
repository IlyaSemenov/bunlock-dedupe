import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fetchCompatibleVersions } from "./registry"
import { clearRegistryCache, openRegistryCache } from "./registry-cache"

const REGISTRY_URL = "https://registry.npmjs.org"
const REGISTRY_ACCEPT = "application/vnd.npm.install-v1+json"

type TestPackument = {
  versions: Record<string, unknown>
}

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

const temporaryCacheDirs: string[] = []
const initialPackument: TestPackument = {
  versions: {
    "1.0.0": {},
  },
}

afterEach(() => {
  for (const cacheDir of temporaryCacheDirs.splice(0)) {
    rmSync(cacheDir, { recursive: true, force: true })
  }
})

function makeCacheDir(): string {
  const cacheDir = mkdtempSync(join(tmpdir(), "bunlock-dedupe-registry-"))
  temporaryCacheDirs.push(cacheDir)
  return cacheDir
}

function isTestPackument(value: unknown): value is TestPackument {
  if (!value || typeof value !== "object") return false
  const { versions } = value as Partial<TestPackument>
  return Boolean(versions && typeof versions === "object")
}

function openCache(cacheDir: string, now: number, packageName = "pkg") {
  return openRegistryCache({
    cacheDir,
    registryUrl: REGISTRY_URL,
    accept: REGISTRY_ACCEPT,
    packageName,
    now: () => now,
    validate: isTestPackument,
  })
}

describe("persistent registry cache", () => {
  test("reuses fresh data and lets --refresh revalidate it", async () => {
    const registryCacheDir = makeCacheDir()
    let calls = 0
    const conditionalEtags: Array<string | null> = []
    const fetchFn = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify(initialPackument), {
          status: 200,
          headers: { ETag: '"revision-1"' },
        })
      }
      conditionalEtags.push(new Headers(init?.headers).get("if-none-match"))
      return new Response(
        JSON.stringify({
          versions: {
            "1.0.0": {},
            "1.1.0": {},
          },
        }),
        { status: 200, headers: { ETag: '"revision-2"' } },
      )
    }) as FetchFn

    await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      fetchFn,
      registryCacheDir,
      nowFn: () => 1_000_000,
    })
    await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      fetchFn,
      registryCacheDir,
      nowFn: () => 1_000_001,
    })
    const refreshed = await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      fetchFn,
      registryCacheDir,
      refresh: true,
      nowFn: () => 1_000_002,
    })

    expect(refreshed).toEqual(["1.1.0", "1.0.0"])
    expect(conditionalEtags).toEqual(['"revision-1"'])
    expect(calls).toBe(2)
  })

  test("serves cached data and updates validators after a registry 304", async () => {
    const registryCacheDir = makeCacheDir()
    let calls = 0
    const conditionalEtags: Array<string | null> = []
    const fetchFn = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify(initialPackument), {
          status: 200,
          headers: { ETag: '"revision-1"' },
        })
      }
      conditionalEtags.push(new Headers(init?.headers).get("if-none-match"))
      return new Response(null, {
        status: 304,
        headers: { ETag: '"revision-2"' },
      })
    }) as FetchFn

    await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      fetchFn,
      registryCacheDir,
      nowFn: () => 1_000_000,
    })
    const revalidated = await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      fetchFn,
      registryCacheDir,
      nowFn: () => 1_000_000 + 5 * 60 * 1000,
    })
    const persisted = await openCache(
      registryCacheDir,
      1_000_000 + 5 * 60 * 1000 + 1,
    )
    const persistedHeaders = new Headers()
    persisted.addConditionalHeaders(persistedHeaders)

    expect(revalidated).toEqual(["1.0.0"])
    expect(conditionalEtags).toEqual(['"revision-1"'])
    expect(persisted.fresh).toBe(true)
    expect(persistedHeaders.get("if-none-match")).toBe('"revision-2"')
    expect(calls).toBe(2)
  })

  test("revalidates stale data with its ETag", async () => {
    const cacheDir = makeCacheDir()
    const initial = await openCache(cacheDir, 1_000_000)
    await initial.store(
      initialPackument,
      new Response(null, { headers: { ETag: '"revision-1"' } }),
    )

    const stale = await openCache(cacheDir, 1_000_000 + 5 * 60 * 1000)
    const headers = new Headers()
    stale.addConditionalHeaders(headers)
    await stale.revalidate(new Response(null, { status: 304 }))
    const freshAgain = await openCache(cacheDir, 1_000_000 + 5 * 60 * 1000 + 1)

    expect(stale.fresh).toBe(false)
    expect(headers.get("if-none-match")).toBe('"revision-1"')
    expect(freshAgain.fresh).toBe(true)
    expect(freshAgain.entry?.data).toEqual(initialPackument)
  })

  test("keeps missing-package data fresh for only one minute", async () => {
    const cacheDir = makeCacheDir()
    const initial = await openCache(cacheDir, 1_000_000, "missing")
    await initial.store(null, new Response(null, { status: 404 }))

    const fresh = await openCache(cacheDir, 1_000_000 + 59_999, "missing")
    const stale = await openCache(cacheDir, 1_000_000 + 60_000, "missing")

    expect(fresh.fresh).toBe(true)
    expect(fresh.entry?.data).toBeNull()
    expect(stale.fresh).toBe(false)
  })

  test("removes cache files unused for 30 days", async () => {
    const cacheDir = makeCacheDir()
    const oldPrefixDir = join(cacheDir, "old")
    const oldCacheFile = join(oldPrefixDir, "entry.json")
    mkdirSync(oldPrefixDir)
    writeFileSync(oldCacheFile, "{}")
    utimesSync(oldCacheFile, 0, 0)

    await openCache(cacheDir, 30 * 24 * 60 * 60 * 1000)

    expect(existsSync(oldCacheFile)).toBe(false)
  })

  test("clears the entire cache directory", async () => {
    const cacheDir = makeCacheDir()
    writeFileSync(join(cacheDir, "entry.json"), "{}")

    const clearedDir = await clearRegistryCache(cacheDir)

    expect(clearedDir).toBe(cacheDir)
    expect(existsSync(cacheDir)).toBe(false)
  })

  test("ignores corrupted entries", async () => {
    const cacheDir = makeCacheDir()
    const initial = await openCache(cacheDir, 1_000_000)
    await initial.store(initialPackument, new Response(null))
    const prefixDir = readdirSync(cacheDir, { withFileTypes: true }).find(
      (entry) => entry.isDirectory(),
    )
    if (!prefixDir) throw new Error("cache prefix directory was not created")
    const cacheFile = readdirSync(join(cacheDir, prefixDir.name)).find(
      (entry) => entry.endsWith(".json"),
    )
    if (!cacheFile) throw new Error("cache entry was not created")
    writeFileSync(join(cacheDir, prefixDir.name, cacheFile), "{")

    const reopened = await openCache(cacheDir, 1_000_001)

    expect(reopened.entry).toBeNull()
    expect(reopened.fresh).toBe(false)
  })
})
