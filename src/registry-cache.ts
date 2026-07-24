import { createHash, randomUUID } from "node:crypto"
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"

import envPaths from "env-paths"

const CACHE_VERSION = 1
const DATA_FRESHNESS_MS = 5 * 60 * 1000
const MISSING_DATA_FRESHNESS_MS = 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const ENTRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const cleanupPromises = new Map<string, Promise<void>>()

type CacheEntry<T> = {
  version: typeof CACHE_VERSION
  checkedAt: number
  etag?: string
  lastModified?: string
  data: T | null
}

export type RegistryDiskCache<T> = {
  entry: CacheEntry<T> | null
  fresh: boolean
  addConditionalHeaders(headers: Headers): void
  store(data: T | null, response: Response): Promise<T | null>
  revalidate(response: Response): Promise<T | null>
}

type OpenRegistryCacheOptions<T> = {
  cacheDir: string
  registryUrl: string
  accept: string
  packageName: string
  now?: () => number
  validate: (value: unknown) => value is T
}

export function defaultRegistryCacheDir(): string {
  return join(envPaths("bunlock-dedupe", { suffix: "" }).cache, "registry-v1")
}

export async function clearRegistryCache(
  cacheDir = defaultRegistryCacheDir(),
): Promise<string> {
  await cleanupPromises.get(cacheDir)
  await rm(cacheDir, { recursive: true, force: true })
  cleanupPromises.delete(cacheDir)
  return cacheDir
}

function cacheFilePath(
  cacheDir: string,
  registryUrl: string,
  accept: string,
  packageName: string,
): string {
  const key = createHash("sha256")
    .update(`${registryUrl}\n${accept}\n${packageName}`)
    .digest("hex")
  return join(cacheDir, key.slice(0, 2), `${key}.json`)
}

function isCacheEntry<T>(
  value: unknown,
  validate: (value: unknown) => value is T,
): value is CacheEntry<T> {
  if (!value || typeof value !== "object") return false
  const entry = value as Partial<CacheEntry<T>>
  if (
    entry.version !== CACHE_VERSION ||
    typeof entry.checkedAt !== "number" ||
    !Number.isFinite(entry.checkedAt)
  ) {
    return false
  }
  if (
    (entry.etag !== undefined && typeof entry.etag !== "string") ||
    (entry.lastModified !== undefined && typeof entry.lastModified !== "string")
  ) {
    return false
  }
  return entry.data === null || validate(entry.data)
}

async function readEntry<T>(
  filePath: string,
  validate: (value: unknown) => value is T,
): Promise<CacheEntry<T> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"))
    return isCacheEntry(parsed, validate) ? parsed : null
  } catch {
    return null
  }
}

async function writeEntry<T>(
  filePath: string,
  entry: CacheEntry<T>,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    await writeFile(tempPath, JSON.stringify(entry), {
      encoding: "utf8",
      mode: 0o600,
    })
    await rename(tempPath, filePath)
  } catch {
    // Cache failures must not prevent registry-backed analysis.
  } finally {
    await unlink(tempPath).catch(() => {})
  }
}

function cleanCache(cacheDir: string, now: number): Promise<void> {
  const existing = cleanupPromises.get(cacheDir)
  if (existing) return existing

  const cleanup = (async (): Promise<void> => {
    const markerPath = join(cacheDir, ".last-cleanup")
    try {
      const lastCleanup = Number(await readFile(markerPath, "utf8"))
      const age = now - lastCleanup
      if (age >= 0 && age < CLEANUP_INTERVAL_MS) return
    } catch {
      // A missing or invalid marker triggers cleanup.
    }

    try {
      const prefixDirs = await readdir(cacheDir, { withFileTypes: true })
      await Promise.all(
        prefixDirs
          .filter((entry) => entry.isDirectory())
          .map(async (prefixDir) => {
            const prefixPath = join(cacheDir, prefixDir.name)
            const files = await readdir(prefixPath, { withFileTypes: true })
            await Promise.all(
              files
                .filter(
                  (entry) =>
                    entry.isFile() &&
                    (entry.name.endsWith(".json") ||
                      entry.name.endsWith(".tmp")),
                )
                .map(async (entry) => {
                  const filePath = join(prefixPath, entry.name)
                  const fileStat = await stat(filePath)
                  if (now - fileStat.mtimeMs >= ENTRY_MAX_AGE_MS) {
                    await unlink(filePath)
                  }
                }),
            )
          }),
      )
      await writeFile(markerPath, String(now), {
        encoding: "utf8",
        mode: 0o600,
      })
    } catch {
      // Cleanup is best-effort and must not affect registry requests.
    }
  })()

  cleanupPromises.set(cacheDir, cleanup)
  return cleanup
}

function isFresh<T>(entry: CacheEntry<T>, now: number): boolean {
  const age = now - entry.checkedAt
  const freshness =
    entry.data === null ? MISSING_DATA_FRESHNESS_MS : DATA_FRESHNESS_MS
  return age >= 0 && age < freshness
}

export async function openRegistryCache<T>(
  options: OpenRegistryCacheOptions<T>,
): Promise<RegistryDiskCache<T>> {
  const now = options.now ?? Date.now
  const filePath = cacheFilePath(
    options.cacheDir,
    options.registryUrl,
    options.accept,
    options.packageName,
  )
  await cleanCache(options.cacheDir, now())
  const entry = await readEntry(filePath, options.validate)

  const write = (
    data: T | null,
    response: Response,
    previous?: CacheEntry<T>,
  ): Promise<T | null> =>
    writeEntry(filePath, {
      version: CACHE_VERSION,
      checkedAt: now(),
      etag: response.headers.get("etag") ?? previous?.etag,
      lastModified:
        response.headers.get("last-modified") ?? previous?.lastModified,
      data,
    }).then(() => data)

  return {
    entry,
    fresh: Boolean(entry && isFresh(entry, now())),
    addConditionalHeaders(headers) {
      if (!entry || entry.data === null) return
      if (entry.etag) {
        headers.set("If-None-Match", entry.etag)
      } else if (entry.lastModified) {
        headers.set("If-Modified-Since", entry.lastModified)
      }
    },
    store(data, response) {
      return write(data, response)
    },
    revalidate(response) {
      if (!entry) return Promise.resolve(null)
      return write(entry.data, response, entry)
    },
  }
}
