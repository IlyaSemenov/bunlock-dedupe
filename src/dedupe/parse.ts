import JSON5 from "json5"

export type DependencyMap = Record<string, string>

export type BunLockWorkspace = {
  name?: string
  dependencies?: DependencyMap
  devDependencies?: DependencyMap
  optionalDependencies?: DependencyMap
  peerDependencies?: DependencyMap
}

export type BunPackageMeta = {
  dependencies?: DependencyMap
  optionalDependencies?: DependencyMap
  peerDependencies?: DependencyMap
  optionalPeers?: string[]
  bundled?: boolean
  bin?: string | Record<string, string>
  os?: string | string[]
  cpu?: string | string[]
}

export type BunPackageEntry = [
  spec: string,
  resolved?: string,
  meta?: BunPackageMeta,
  integrity?: string,
]

export type BunLockFile = {
  lockfileVersion?: number
  configVersion?: number
  workspaces?: Record<string, BunLockWorkspace>
  packages?: Record<string, BunPackageEntry>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function isPackageEntry(value: unknown): value is BunPackageEntry {
  return Array.isArray(value) && typeof value[0] === "string"
}

export function packageEntryMeta(
  entry: BunPackageEntry,
): BunPackageMeta | undefined {
  const meta = entry[2]
  return isObject(meta) ? (meta as BunPackageMeta) : undefined
}

export function normalizeDependencyMap(value: unknown): DependencyMap {
  if (!isObject(value)) {
    return {}
  }

  const normalized: DependencyMap = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      normalized[key] = item
    }
  }

  return normalized
}

export function parseResolvedSpec(
  spec: string,
): { name: string; version: string } | null {
  const atIndex = spec.lastIndexOf("@")
  if (atIndex <= 0 || atIndex >= spec.length - 1) {
    return null
  }

  const name = spec.slice(0, atIndex)
  const version = spec.slice(atIndex + 1)
  if (!name || !version) {
    return null
  }

  return { name, version }
}

export function parseBunLock(lockText: string): BunLockFile {
  const parsed = JSON5.parse(lockText)
  if (!isObject(parsed)) {
    throw new Error("bun.lock must parse to an object")
  }

  return parsed as BunLockFile
}
