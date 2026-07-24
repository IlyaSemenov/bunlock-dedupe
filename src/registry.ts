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

const REGISTRY_RETRY_DELAYS_MS = [250, 500, 1000] as const

/**
 * Thrown when a registry request fails transiently (network error, 5xx, rate
 * limit, malformed JSON) rather than confirming that a package does not exist.
 *
 * Such failures must abort the run instead of being silently treated as a
 * missing package: continuing would silently drop update suggestions and
 * produce a report skewed by data that never arrived. A genuine 404 stays a
 * `null` result and is not an error.
 */
export class RegistryError extends Error {
  constructor(
    readonly packageName: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`Failed to fetch ${packageName} from registry: ${message}`, options)
    this.name = "RegistryError"
  }
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
  retryDelayFn?: (delayMs: number) => Promise<void>
  cache?: PackumentCache
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
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
 * 200 OK packuments and 404 misses (a `null` result) stay cached. Transient
 * failures (network errors, 5xx, malformed JSON) are retried 3 times and
 * then throw {@link RegistryError}. A final failure evicts the in-flight entry,
 * so a later call can try again instead of replaying a rejected promise.
 */
async function fetchPackument(
  packageName: string,
  options: RegistryOptions,
): Promise<Packument | null> {
  const { cache } = options
  const existing = cache?.get(packageName)
  if (existing) return existing

  const promise = (async (): Promise<Packument | null> => {
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
      return Object.keys(versions).length > 0 ? { versions } : null
    }

    const fetchImpl = options.fetchFn ?? fetch
    const retryDelayFn = options.retryDelayFn ?? wait
    const encodedName = encodePackageNameForRegistryPath(packageName)
    const fetchOnce = (): Promise<Packument | null> =>
      fetchImpl(`https://registry.npmjs.org/${encodedName}`, {
        headers: { Accept: "application/vnd.npm.install-v1+json" },
      })
        .catch((error: unknown) => {
          throw new RegistryError(packageName, "network request failed", {
            cause: error,
          })
        })
        .then((response) => {
          // A genuine 404 confirms the package does not exist — a cacheable
          // `null`, not a transient failure.
          if (response.status === 404) return null
          if (!response.ok) {
            throw new RegistryError(
              packageName,
              `registry responded with status ${response.status}`,
            )
          }

          return response.json().catch((error: unknown) => {
            throw new RegistryError(
              packageName,
              "malformed registry response",
              { cause: error },
            )
          })
        })

    const fetchWithRetries = (attempt = 0): Promise<Packument | null> =>
      fetchOnce().catch(async (error: unknown) => {
        const delayMs = REGISTRY_RETRY_DELAYS_MS[attempt]
        if (!(error instanceof RegistryError) || delayMs === undefined) {
          throw error
        }
        await retryDelayFn(delayMs)
        return fetchWithRetries(attempt + 1)
      })

    return fetchWithRetries()
  })()

  cache?.set(packageName, promise)
  // Evict a rejected in-flight entry so a later caller does not observe the
  // transient failure as a cached, permanent result.
  promise.catch(() => cache?.delete(packageName))
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
