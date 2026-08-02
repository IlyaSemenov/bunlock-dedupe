import { describe, expect, test } from "bun:test"

import {
  createPackumentCache,
  fetchCompatibleVersions,
  fetchPackageMetadata,
  RegistryError,
} from "./registry"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

function makeFetch(responses: Record<string, unknown>): FetchFn {
  return async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString()
    const body = responses[url]
    if (body === undefined) {
      return new Response(null, { status: 404 })
    }
    return new Response(JSON.stringify(body), { status: 200 })
  }
}

function makeReadDir(
  entries: Record<string, string[]>,
): (path: string) => string[] {
  return (path: string) => {
    const result = entries[path]
    if (!result) throw new Error(`ENOENT: ${path}`)
    return result
  }
}

function makeReadFile(files: Record<string, string>): (path: string) => string {
  return (path: string) => {
    const result = files[path]
    if (!result) throw new Error(`ENOENT: ${path}`)
    return result
  }
}

/**
 * Build a readFileFn that returns a minimal `package.json` for any Bun cache
 * layout (index dir or canonical direct dir), deriving the version from the
 * directory name. Used by offline tests that only care about version listing.
 */
function makeReadPackageJsonFromPath(): (path: string) => string {
  return (path: string) => {
    if (!path.endsWith("/package.json")) throw new Error(`ENOENT: ${path}`)
    const match = path.match(/([^/]+)@@@\d+\/package\.json$/)
    if (!match) throw new Error(`ENOENT: ${path}`)
    const version = (match[1] ?? "").replace(/^[^@]+@/, "")
    return JSON.stringify({ version })
  }
}

// ---------------------------------------------------------------------------
// fetchCompatibleVersions — online
// ---------------------------------------------------------------------------

describe("fetchCompatibleVersions (online)", () => {
  const abbreviatedMeta = {
    versions: {
      "1.0.0": {},
      "1.1.0": {},
      "1.2.0": {},
      "2.0.0": {},
      "2.1.0": {},
    },
  }

  test("returns versions matching a single range, sorted descending", async () => {
    const result = await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      fetchFn: makeFetch({
        "https://registry.npmjs.org/pkg": abbreviatedMeta,
      }),
    })
    expect(result).toEqual(["1.2.0", "1.1.0", "1.0.0"])
  })

  test("intersects multiple ranges", async () => {
    const result = await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0", ">=1.1.0"],
      fetchFn: makeFetch({
        "https://registry.npmjs.org/pkg": abbreviatedMeta,
      }),
    })
    expect(result).toEqual(["1.2.0", "1.1.0"])
  })

  test("excludes prereleases unless the range explicitly includes them", async () => {
    const meta = {
      versions: {
        "8.1.5": {},
        "8.2.0-beta.0": {},
      },
    }

    const stableResult = await fetchCompatibleVersions("pkg", {
      ranges: ["^8.0.0"],
      fetchFn: makeFetch({ "https://registry.npmjs.org/pkg": meta }),
    })
    const prereleaseResult = await fetchCompatibleVersions("pkg", {
      ranges: ["^8.2.0-beta.0"],
      fetchFn: makeFetch({ "https://registry.npmjs.org/pkg": meta }),
    })

    expect(stableResult).toEqual(["8.1.5"])
    expect(prereleaseResult).toEqual(["8.2.0-beta.0"])
  })

  test("returns empty array when no versions match", async () => {
    const result = await fetchCompatibleVersions("pkg", {
      ranges: ["^3.0.0"],
      fetchFn: makeFetch({
        "https://registry.npmjs.org/pkg": abbreviatedMeta,
      }),
    })
    expect(result).toEqual([])
  })

  test("returns empty array without retrying registry 404", async () => {
    let calls = 0
    const result = await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      fetchFn: (async () => {
        calls += 1
        return new Response(null, { status: 404 })
      }) as FetchFn,
    })
    expect(result).toEqual([])
    expect(calls).toBe(1)
  })

  test("retries a network failure 3 times before succeeding", async () => {
    let calls = 0
    const delays: number[] = []
    const result = await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      fetchFn: (async () => {
        calls += 1
        if (calls < 4) throw new Error("network error")
        return new Response(JSON.stringify(abbreviatedMeta), { status: 200 })
      }) as FetchFn,
      retryDelayFn: async (delayMs) => {
        delays.push(delayMs)
      },
    })

    expect(result).toEqual(["1.2.0", "1.1.0", "1.0.0"])
    expect(calls).toBe(4)
    expect(delays).toEqual([250, 500, 1000])
  })

  test("throws RegistryError after 3 network retries", async () => {
    let calls = 0
    const promise = fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      fetchFn: (async () => {
        calls += 1
        throw new Error("network error")
      }) as FetchFn,
      retryDelayFn: async () => {},
    })
    await expect(promise).rejects.toBeInstanceOf(RegistryError)
    expect(calls).toBe(4)
  })

  test("throws RegistryError on 5xx response", async () => {
    const promise = fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      fetchFn: (async () => new Response(null, { status: 503 })) as FetchFn,
      retryDelayFn: async () => {},
    })
    await expect(promise).rejects.toBeInstanceOf(RegistryError)
  })

  test("throws RegistryError on 429 rate-limit response", async () => {
    const promise = fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      fetchFn: (async () => new Response(null, { status: 429 })) as FetchFn,
      retryDelayFn: async () => {},
    })
    await expect(promise).rejects.toBeInstanceOf(RegistryError)
  })

  test("encodes scoped package name correctly", async () => {
    let calledUrl = ""
    const result = await fetchCompatibleVersions("@scope/pkg", {
      ranges: ["^1.0.0"],
      fetchFn: (async (input: string | URL | Request) => {
        calledUrl = typeof input === "string" ? input : input.toString()
        return new Response(JSON.stringify(abbreviatedMeta), { status: 200 })
      }) as FetchFn,
    })
    expect(calledUrl).toBe("https://registry.npmjs.org/@scope%2Fpkg")
    expect(result).toEqual(["1.2.0", "1.1.0", "1.0.0"])
  })

  test("skips non-semver versions silently", async () => {
    const meta = {
      versions: {
        "1.0.0": {},
        "not-a-version": {},
        "1.1.0": {},
      },
    }
    const result = await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      fetchFn: makeFetch({ "https://registry.npmjs.org/pkg": meta }),
    })
    expect(result).toEqual(["1.1.0", "1.0.0"])
  })
})

// ---------------------------------------------------------------------------
// fetchCompatibleVersions — offline
// ---------------------------------------------------------------------------

describe("fetchCompatibleVersions (offline)", () => {
  const cacheDir = "/fake/cache"
  const readFileFn = makeReadPackageJsonFromPath()

  test("reads versions from cache dirs, sorted descending", async () => {
    const result = await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({
        "/fake/cache/pkg": ["1.0.0@@@1", "1.1.0@@@1", "2.0.0@@@1"],
      }),
      readFileFn,
    })
    expect(result).toEqual(["1.1.0", "1.0.0"])
  })

  test("handles @@@N suffix variants (not just @@@1)", async () => {
    const result = await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({
        "/fake/cache/pkg": ["1.0.0@@@1", "1.1.0@@@2", "1.2.0@@@3"],
      }),
      readFileFn,
    })
    expect(result).toEqual(["1.2.0", "1.1.0", "1.0.0"])
  })

  test("handles scoped packages", async () => {
    const result = await fetchCompatibleVersions("@scope/pkg", {
      ranges: ["^1.0.0"],
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({
        "/fake/cache/@scope/pkg": ["1.0.0@@@1", "1.1.0@@@1"],
      }),
      readFileFn,
    })
    expect(result).toEqual(["1.1.0", "1.0.0"])
  })

  test("reads versions from canonical direct cache dirs", async () => {
    const result = await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({
        "/fake/cache": [
          "pkg@1.0.0@@@1",
          "pkg@1.1.0@@@1",
          "pkg@2.0.0@@@1",
          "other@1.9.0@@@1",
        ],
      }),
      readFileFn,
    })
    expect(result).toEqual(["1.1.0", "1.0.0"])
  })

  test("reads scoped versions from canonical direct cache dirs", async () => {
    const result = await fetchCompatibleVersions("@scope/pkg", {
      ranges: ["^1.0.0"],
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({
        "/fake/cache/@scope": [
          "pkg@1.0.0@@@1",
          "pkg@1.1.0@@@1",
          "other@1.9.0@@@1",
        ],
      }),
      readFileFn,
    })
    expect(result).toEqual(["1.1.0", "1.0.0"])
  })

  test("returns empty array when cache dir is missing", async () => {
    const result = await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({}),
      readFileFn,
    })
    expect(result).toEqual([])
  })

  test("skips entries that don't match @@@N pattern", async () => {
    const result = await fetchCompatibleVersions("pkg", {
      ranges: ["^1.0.0"],
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({
        "/fake/cache/pkg": ["1.0.0@@@1", "some-other-dir", "1.1.0@@@1"],
      }),
      readFileFn,
    })
    expect(result).toEqual(["1.1.0", "1.0.0"])
  })
})

// ---------------------------------------------------------------------------
// fetchPackageMetadata — online
// ---------------------------------------------------------------------------

describe("fetchPackageMetadata (online)", () => {
  const meta = {
    version: "1.1.0",
    dependencies: { dep: "^2.0.0" },
    peerDependencies: { peer: "^3.0.0" },
  }

  test("returns metadata for a package version", async () => {
    const result = await fetchPackageMetadata("pkg", "1.1.0", {
      fetchFn: makeFetch({
        "https://registry.npmjs.org/pkg": { versions: { "1.1.0": meta } },
      }),
    })
    expect(result).toEqual(meta)
  })

  test("returns null on 404", async () => {
    const result = await fetchPackageMetadata("pkg", "9.9.9", {
      fetchFn: makeFetch({}),
    })
    expect(result).toBeNull()
  })

  test("throws RegistryError on network failure", async () => {
    const promise = fetchPackageMetadata("pkg", "1.0.0", {
      fetchFn: (async () => {
        throw new Error("network error")
      }) as FetchFn,
      retryDelayFn: async () => {},
    })
    await expect(promise).rejects.toBeInstanceOf(RegistryError)
  })

  test("throws RegistryError on malformed registry response", async () => {
    const promise = fetchPackageMetadata("pkg", "1.0.0", {
      fetchFn: (async () =>
        new Response("not json", { status: 200 })) as FetchFn,
      retryDelayFn: async () => {},
    })
    await expect(promise).rejects.toBeInstanceOf(RegistryError)
  })

  test("encodes scoped package name correctly", async () => {
    let calledUrl = ""
    await fetchPackageMetadata("@scope/pkg", "1.0.0", {
      fetchFn: (async (input: string | URL | Request) => {
        calledUrl = typeof input === "string" ? input : input.toString()
        return new Response(JSON.stringify({ versions: { "1.0.0": meta } }), {
          status: 200,
        })
      }) as FetchFn,
    })
    expect(calledUrl).toBe("https://registry.npmjs.org/@scope%2Fpkg")
  })
})

// ---------------------------------------------------------------------------
// fetchPackageMetadata — offline
// ---------------------------------------------------------------------------

describe("fetchPackageMetadata (offline)", () => {
  const cacheDir = "/fake/cache"
  const pkgJson = JSON.stringify({
    version: "1.1.0",
    dependencies: { dep: "^2.0.0" },
  })

  test("reads package.json from cache", async () => {
    const result = await fetchPackageMetadata("pkg", "1.1.0", {
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({ "/fake/cache/pkg": ["1.1.0@@@1"] }),
      readFileFn: makeReadFile({
        "/fake/cache/pkg/1.1.0@@@1/package.json": pkgJson,
      }),
    })
    expect(result).toEqual(JSON.parse(pkgJson))
  })

  test("handles any @@@N suffix", async () => {
    const result = await fetchPackageMetadata("pkg", "1.2.0", {
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({ "/fake/cache/pkg": ["1.2.0@@@3"] }),
      readFileFn: makeReadFile({
        "/fake/cache/pkg/1.2.0@@@3/package.json": pkgJson,
      }),
    })
    expect(result).toEqual(JSON.parse(pkgJson))
  })

  test("returns null when version not in cache", async () => {
    const result = await fetchPackageMetadata("pkg", "9.9.9", {
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({ "/fake/cache/pkg": ["1.0.0@@@1"] }),
      readFileFn: makeReadFile({}),
    })
    expect(result).toBeNull()
  })

  test("handles scoped packages", async () => {
    const result = await fetchPackageMetadata("@scope/pkg", "1.0.0", {
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({ "/fake/cache/@scope/pkg": ["1.0.0@@@1"] }),
      readFileFn: makeReadFile({
        "/fake/cache/@scope/pkg/1.0.0@@@1/package.json": pkgJson,
      }),
    })
    expect(result).toEqual(JSON.parse(pkgJson))
  })

  test("reads package.json from canonical direct cache dirs", async () => {
    const result = await fetchPackageMetadata("pkg", "1.1.0", {
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({
        "/fake/cache": ["pkg@1.1.0@@@1"],
      }),
      readFileFn: makeReadFile({
        "/fake/cache/pkg@1.1.0@@@1/package.json": pkgJson,
      }),
    })
    expect(result).toEqual(JSON.parse(pkgJson))
  })

  test("reads scoped package.json from canonical direct cache dirs", async () => {
    const result = await fetchPackageMetadata("@scope/pkg", "1.1.0", {
      offline: true,
      cacheDir,
      readDirFn: makeReadDir({
        "/fake/cache/@scope": ["pkg@1.1.0@@@1"],
      }),
      readFileFn: makeReadFile({
        "/fake/cache/@scope/pkg@1.1.0@@@1/package.json": pkgJson,
      }),
    })
    expect(result).toEqual(JSON.parse(pkgJson))
  })
})

// ---------------------------------------------------------------------------
// Packument cache
// ---------------------------------------------------------------------------

describe("packument cache", () => {
  const meta = { version: "1.1.0" }
  const packument = { versions: { "1.1.0": meta } }

  test("shares one network request across cache readers", async () => {
    let calls = 0
    const cache = createPackumentCache()
    const fetchFn = (async () => {
      calls += 1
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as FetchFn

    await fetchCompatibleVersions("pkg", { ranges: ["^1.0.0"], fetchFn, cache })
    const reused = await fetchPackageMetadata("pkg", "1.1.0", {
      fetchFn,
      cache,
    })

    expect(reused).toEqual(meta)
    expect(calls).toBe(1)
  })

  test("evicts a failed request so the next call retries", async () => {
    let calls = 0
    const cache = createPackumentCache()
    const fetchFn = (async () => {
      calls += 1
      if (calls <= 4) throw new Error("network error")
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as FetchFn

    await expect(
      fetchPackageMetadata("pkg", "1.1.0", {
        fetchFn,
        cache,
        retryDelayFn: async () => {},
      }),
    ).rejects.toBeInstanceOf(RegistryError)
    // The transient failure must not poison the cache: a later read retries
    // and succeeds rather than replaying the rejected promise.
    const retried = await fetchPackageMetadata("pkg", "1.1.0", {
      fetchFn,
      cache,
    })

    expect(retried).toEqual(meta)
    expect(calls).toBe(5)
  })

  test("concurrent readers of a failing request all reject and leave an empty cache", async () => {
    let calls = 0
    const cache = createPackumentCache()
    const fetchFn = (async () => {
      calls += 1
      throw new Error("network error")
    }) as FetchFn

    // Mirrors the Promise.all fan-out in analyze: several readers share one
    // in-flight promise, so all of them must observe the rejection and none
    // may keep the failure cached.
    const results = await Promise.allSettled([
      fetchPackageMetadata("pkg", "1.1.0", {
        fetchFn,
        cache,
        retryDelayFn: async () => {},
      }),
      fetchPackageMetadata("pkg", "1.1.0", {
        fetchFn,
        cache,
        retryDelayFn: async () => {},
      }),
    ])

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"])
    for (const result of results) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
        RegistryError,
      )
    }
    // One shared retry sequence for both readers; the failure is not cached.
    expect(calls).toBe(4)
    expect(cache.size).toBe(0)
  })
})
