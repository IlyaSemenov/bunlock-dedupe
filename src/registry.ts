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

export async function fetchCompatibleVersions(
  packageName: string,
  options: {
    ranges: string[]
    offline?: boolean
    cacheDir?: string
    fetchFn?: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>
    readDirFn?: (path: string) => string[]
  },
): Promise<string[]> {
  const { ranges, offline, readDirFn = readdirSync } = options
  const cacheDir = options.cacheDir ?? defaultCacheDir()

  const satisfiesAllRanges = (version: string): boolean => {
    if (!semver.valid(version)) return false
    return ranges.every((range) => {
      const valid = semver.validRange(range)
      if (!valid) return false
      return semver.satisfies(version, valid, { includePrerelease: true })
    })
  }

  if (offline) {
    const versions: string[] = []
    for (const entry of readCacheEntries(packageName, cacheDir, readDirFn)) {
      if (satisfiesAllRanges(entry.version)) {
        versions.push(entry.version)
      }
    }
    return [...new Set(versions)].sort((a, b) => semver.rcompare(a, b))
  }

  const fetchImpl = options.fetchFn ?? fetch
  const encodedName = encodePackageNameForRegistryPath(packageName)
  try {
    const response = await fetchImpl(
      `https://registry.npmjs.org/${encodedName}`,
      { headers: { Accept: "application/vnd.npm.install-v1+json" } },
    )
    if (!response.ok) return []
    const data = (await response.json()) as {
      versions?: Record<string, unknown>
    }
    const allVersions = Object.keys(data.versions ?? {})
    return allVersions
      .filter(satisfiesAllRanges)
      .sort((a, b) => semver.rcompare(a, b))
  } catch {
    return []
  }
}

export async function fetchPackageMetadata(
  packageName: string,
  version: string,
  options: {
    offline?: boolean
    cacheDir?: string
    fetchFn?: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>
    readDirFn?: (path: string) => string[]
    readFileFn?: (path: string) => string
  },
): Promise<PackageMetadata | null> {
  const {
    offline,
    readDirFn = readdirSync,
    readFileFn = (p) => readFileSync(p, "utf8"),
  } = options
  const cacheDir = options.cacheDir ?? defaultCacheDir()

  if (offline) {
    for (const entry of readCacheEntries(packageName, cacheDir, readDirFn)) {
      if (entry.version !== version) continue

      try {
        const pkgJsonPath = join(entry.packagePath, "package.json")
        const raw = readFileFn(pkgJsonPath)
        return JSON.parse(raw) as PackageMetadata
      } catch {
        // Try the next cache entry; index dirs may contain stale symlinks.
      }
    }

    return null
  }

  const fetchImpl = options.fetchFn ?? fetch
  const encodedName = encodePackageNameForRegistryPath(packageName)
  try {
    const response = await fetchImpl(
      `https://registry.npmjs.org/${encodedName}/${version}`,
    )
    if (!response.ok) return null
    return (await response.json()) as PackageMetadata
  } catch {
    return null
  }
}
