import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import semver from "semver"

export type PackageMetadata = {
  version: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  optionalDependencies?: Record<string, string>
  bin?: string | Record<string, string>
  cpu?: string | string[]
  os?: string | string[]
  optionalPeers?: string[]
  dist?: {
    integrity?: string
  }
}

type Packument = {
  versions?: Record<string, PackageMetadata>
}

/**
 * Packument cache shared across analyze and safety passes within one run.
 *
 * Stores the in-flight {@link Packument} fetch per package so concurrent
 * callers (e.g. `Promise.all` over blocking requesters that resolve to the
 * same package name) share one network request, and later passes read from
 * the cache instead of refetching. Pass the same instance to multiple calls
 * ({@link fetchCompatibleVersions}, {@link fetchPackageMetadata}, the
 * orchestrators in `./dedupe`).
 */
export type PackumentCache = Map<string, Promise<Packument | null>>

export function createPackumentCache(): PackumentCache {
  return new Map()
}

type RegistryOptions = {
  offline?: boolean
  cacheDir?: string
  fetchFn?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>
  readDirFn?: (path: string) => string[]
  readFileFn?: (path: string) => string
  cache?: PackumentCache
}

function encodePackageNameForRegistryPath(packageName: string): string {
  if (packageName.startsWith("@")) {
    const slashIndex = packageName.indexOf("/")
    if (slashIndex !== -1) {
      return (
        packageName.slice(0, slashIndex) +
        "%2F" +
        packageName.slice(slashIndex + 1)
      )
    }
  }
  return packageName
}

function defaultCacheDir(): string {
  return join(homedir(), ".bun", "install", "cache")
}

function parseCacheVersionDir(dirName: string): string | null {
  const match = dirName.match(/^(.+)@@@\d+$/)
  return match?.[1] ?? null
}

function packageCacheIndexPath(packageName: string, cacheDir: string): string {
  if (packageName.startsWith("@")) {
    const slashIndex = packageName.indexOf("/")
    if (slashIndex !== -1) {
      const scope = packageName.slice(0, slashIndex)
      const name = packageName.slice(slashIndex + 1)
      return join(cacheDir, scope, name)
    }
  }
  return join(cacheDir, packageName)
}

function packageCacheDirectBasePath(
  packageName: string,
  cacheDir: string,
): { basePath: string; entryPrefix: string } {
  if (packageName.startsWith("@")) {
    const slashIndex = packageName.indexOf("/")
    if (slashIndex !== -1) {
      return {
        basePath: join(cacheDir, packageName.slice(0, slashIndex)),
        entryPrefix: packageName.slice(slashIndex + 1),
      }
    }
  }

  return { basePath: cacheDir, entryPrefix: packageName }
}

type CacheEntry = {
  version: string
  packagePath: string
}

function readCacheEntries(
  packageName: string,
  cacheDir: string,
  readDirFn: (path: string) => string[],
): CacheEntry[] {
  const entries: CacheEntry[] = []
  const seenPackagePaths = new Set<string>()
  const pushEntry = (version: string | null, packagePath: string): void => {
    if (!version || seenPackagePaths.has(packagePath)) return
    entries.push({ version, packagePath })
    seenPackagePaths.add(packagePath)
  }

  try {
    const pkgDir = packageCacheIndexPath(packageName, cacheDir)
    for (const entry of readDirFn(pkgDir)) {
      pushEntry(parseCacheVersionDir(entry), join(pkgDir, entry))
    }
  } catch {
    // Bun may only have direct cache dirs and no package index dir.
  }

  try {
    const { basePath, entryPrefix } = packageCacheDirectBasePath(
      packageName,
      cacheDir,
    )
    const directPrefix = `${entryPrefix}@`
    for (const entry of readDirFn(basePath)) {
      if (!entry.startsWith(directPrefix)) continue
      const version = parseCacheVersionDir(entry.slice(directPrefix.length))
      pushEntry(version, join(basePath, entry))
    }
  } catch {
    // Missing cache dirs should behave like an empty offline registry.
  }

  return entries
}

/**
 * Fetch the abbreviated registry packument for `packageName`, with caching.
 *
 * Online: a single GET to `/packageName` with the abbreviated install-v1 Accept
 * returns every version plus per-version metadata in one response. Offline:
 * the packument is reconstructed from the local Bun cache.
 *
 * The in-flight promise is stored in `options.cache` immediately so concurrent
 * callers (e.g. several `Promise.all` branches that resolve to the same
 * package name) share one network request. Only confirmed outcomes are kept:
 * 200 OK packuments and 404 misses stay cached; transient failures (network
 * errors, 5xx, malformed JSON) evict themselves so the next call retries
 * instead of being poisoned for the rest of the run.
 */
async function fetchPackument(
  packageName: string,
  options: RegistryOptions,
): Promise<Packument | null> {
  const { cache } = options
  const existing = cache?.get(packageName)
  if (existing) return existing

  const promise = (async (): Promise<Packument | null> => {
    let result: Packument | null = null
    let cacheable = true

    if (options.offline) {
      const {
        readDirFn = readdirSync,
        readFileFn = (p) => readFileSync(p, "utf8"),
      } = options
      const cacheDir = options.cacheDir ?? defaultCacheDir()
      const versions: Record<string, PackageMetadata> = {}
      for (const entry of readCacheEntries(packageName, cacheDir, readDirFn)) {
        if (versions[entry.version]) continue
        try {
          const raw = readFileFn(join(entry.packagePath, "package.json"))
          // Trust the cache dir name as the version key; the package.json
          // inside may be stale or mismatched in unusual layouts.
          versions[entry.version] = JSON.parse(raw) as PackageMetadata
        } catch {
          // Stale index dirs and unreadable entries are skipped.
        }
      }
      result = Object.keys(versions).length > 0 ? { versions } : null
    } else {
      const fetchImpl = options.fetchFn ?? fetch
      const encodedName = encodePackageNameForRegistryPath(packageName)
      try {
        const response = await fetchImpl(
          `https://registry.npmjs.org/${encodedName}`,
          { headers: { Accept: "application/vnd.npm.install-v1+json" } },
        )
        if (response.ok) {
          try {
            result = (await response.json()) as Packument
          } catch {
            // Malformed JSON — treat as transient so the next call retries.
            cacheable = false
          }
        } else if (response.status === 404) {
          result = null
        } else {
          // 5xx, rate limits, etc. — retryable on a subsequent call.
          cacheable = false
        }
      } catch {
        // Network failure — retryable on a subsequent call.
        cacheable = false
      }
    }

    if (!cacheable && cache) {
      // Evict our own in-flight entry so the next caller retries instead of
      // observing a transient failure as a permanent miss.
      cache.delete(packageName)
    }

    return result
  })()

  cache?.set(packageName, promise)
  return promise
}

export async function fetchCompatibleVersions(
  packageName: string,
  options: { ranges: string[] } & RegistryOptions,
): Promise<string[]> {
  const { ranges } = options

  const satisfiesAllRanges = (version: string): boolean => {
    if (!semver.valid(version)) return false
    return ranges.every((range) => {
      const valid = semver.validRange(range)
      if (!valid) return false
      return semver.satisfies(version, valid, { includePrerelease: true })
    })
  }

  const packument = await fetchPackument(packageName, options)
  return Object.keys(packument?.versions ?? {})
    .filter(satisfiesAllRanges)
    .sort((a, b) => semver.rcompare(a, b))
}

export async function fetchPackageMetadata(
  packageName: string,
  version: string,
  options: RegistryOptions,
): Promise<PackageMetadata | null> {
  const packument = await fetchPackument(packageName, options)
  return packument?.versions?.[version] ?? null
}
