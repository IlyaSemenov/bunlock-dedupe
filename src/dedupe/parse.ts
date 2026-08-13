import JSON5 from "json5"

export type DependencyMap = Record<string, string>

export type BunLockWorkspace = {
  /**
   * Optional in Bun lockfiles. When present, it is also used as the lookup
   * context for workspace-scoped lock keys.
   */
  name?: string
  dependencies?: DependencyMap
  devDependencies?: DependencyMap
  optionalDependencies?: DependencyMap
  peerDependencies?: DependencyMap
}

/**
 * Metadata stored as the third item of a Bun package tuple.
 *
 * `bundled` is context-specific in Bun lockfiles: it belongs to entries under
 * the package that bundles them and must not be blindly copied to another
 * lock key when reusing a package tuple as a dedupe template.
 */
export type BunPackageMeta = {
  dependencies?: DependencyMap
  optionalDependencies?: DependencyMap
  peerDependencies?: DependencyMap
  /** Peer dependency names Bun treats as optional. */
  optionalPeers?: string[]
  /** True only inside the package subtree that actually bundles this entry. */
  bundled?: boolean
  bin?: string | Record<string, string>
  os?: string | string[]
  cpu?: string | string[]
}

/**
 * Bun lockfile package tuple:
 * `[name@version, resolved, metadata, integrity]`.
 *
 * Bun omits trailing values freely, so every item after the package spec is
 * optional even when most registry entries include all four positions.
 */
export type BunPackageEntry = [
  /** Resolved package spec in `name@version` form. */
  spec: string,
  /** Optional tuple slot; registry packages commonly use an empty string here. */
  resolved?: string,
  meta?: BunPackageMeta,
  integrity?: string,
]

/** Parsed shape used by this tool; Bun may preserve additional top-level keys. */
export type BunLockFile = {
  lockfileVersion?: number
  configVersion?: number
  workspaces?: Record<string, BunLockWorkspace>
  /** Canonical map Bun writes for package.json overrides and resolutions. */
  overrides?: DependencyMap
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

/** True when a peer is optional and is not also installed as a dependency. */
export function isOptionalPeerDependency(
  metadata: Pick<
    BunPackageMeta,
    "dependencies" | "optionalDependencies" | "optionalPeers"
  >,
  dependencyName: string,
): boolean {
  if (
    !Array.isArray(metadata.optionalPeers) ||
    !metadata.optionalPeers.includes(dependencyName)
  ) {
    return false
  }

  return (
    !Object.hasOwn(
      normalizeDependencyMap(metadata.dependencies),
      dependencyName,
    ) &&
    !Object.hasOwn(
      normalizeDependencyMap(metadata.optionalDependencies),
      dependencyName,
    )
  )
}

/**
 * Splits Bun's resolved package spec (`name@version`) using the last `@`, so
 * scoped package names such as `@scope/name@1.0.0` are handled correctly.
 */
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

  const overrides = parsed.overrides
  if (overrides !== undefined) {
    if (!isObject(overrides) || Array.isArray(overrides)) {
      throw new Error("bun.lock overrides must be an object")
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (typeof value !== "string") {
        throw new Error(
          `bun.lock override for ${JSON.stringify(name)} must be a string`,
        )
      }
    }
  }

  return parsed as BunLockFile
}
