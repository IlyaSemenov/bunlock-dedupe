import { isDeepStrictEqual } from "node:util"

import semver from "semver"

import {
  type BunPackageMeta,
  effectiveDependencyRange,
  evaluateRangeCompatibility,
  isGitPackageEntry,
  isOptionalPeerDependency,
  isPackageEntry,
  packageEntryMeta,
  parseBunLock,
  parseResolvedSpec,
  renderBunLock,
  resolveDependencyLockKey,
} from "../bunlock"
import type { ProgressFn } from "../progress"
import {
  createPackumentCache,
  fetchPackageMetadata,
  type PackageMetadata,
} from "../registry"
import { compareStrings } from "../utils"

const dependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const

type MetadataField = (typeof dependencyFields)[number] | "optionalPeers"

/** One restored dependency map or optional-peer list. */
export type RepairChange = {
  field: MetadataField
  before: BunPackageMeta[MetadataField]
  after: BunPackageMeta[MetadataField]
}

/** A lock entry whose dependency declarations differ from published metadata. */
export type RepairedEntry = {
  lockKey: string
  changes: RepairChange[]
}

/** Why an entry cannot be restored from the public registry. */
export type RepairSkipReason =
  | "not-registry"
  | "patched"
  | "metadata-unavailable"
  | "invalid-metadata"
  | "no-integrity"
  | "integrity-mismatch"
  | "missing-dependencies"

/** A published requirement not satisfied by the unchanged package resolutions. */
export type RepairConflict = {
  lockKey: string
  dependencyName: string
  range: string
  /** Undefined when the lockfile contains no entry in this requester's context. */
  resolvedVersion?: string
}

/** Restored text plus changes, skipped entries, and exposed resolution conflicts. */
export type RepairResult = {
  changed: boolean
  lockText: string
  repairedEntries: RepairedEntry[]
  skippedEntries: {
    lockKey: string
    reason: RepairSkipReason
    missingDependencies?: string[]
  }[]
  conflicts: RepairConflict[]
}

/** Registry controls and progress for restoration of the locked package versions. */
export type RepairOptions = Pick<
  Parameters<typeof fetchPackageMetadata>[2],
  "fetchFn" | "refresh" | "registryCacheDir" | "retryDelayFn"
> & {
  onProgress?: ProgressFn
}

/** Reject malformed declarations instead of turning corrupt registry data into removals. */
function validMetadata(meta: PackageMetadata, version: string): boolean {
  if (meta.version !== version) return false
  for (const field of dependencyFields) {
    const value = meta[field]
    if (value === undefined) continue
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.values(value).some((range) => typeof range !== "string")
    )
      return false
  }
  if (meta.peerDependenciesMeta !== undefined) {
    if (
      !meta.peerDependenciesMeta ||
      typeof meta.peerDependenciesMeta !== "object" ||
      Array.isArray(meta.peerDependenciesMeta) ||
      Object.values(meta.peerDependenciesMeta).some(
        (value) =>
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          (value.optional !== undefined && typeof value.optional !== "boolean"),
      )
    )
      return false
  }
  return true
}

/** Compare archive identity, including older lockfiles that only recorded SHA-1. */
function integritySkipReason(
  integrity: string | undefined,
  meta: PackageMetadata,
): "no-integrity" | "integrity-mismatch" | undefined {
  const published =
    typeof meta.dist?.integrity === "string"
      ? meta.dist.integrity.split(/\s+/)
      : []
  if (
    typeof meta.dist?.shasum === "string" &&
    /^[a-f\d]{40}$/i.test(meta.dist.shasum)
  ) {
    published.push(
      `sha1-${Buffer.from(meta.dist.shasum, "hex").toString("base64")}`,
    )
  }
  if (!integrity || published.length === 0) return "no-integrity"
  if (!integrity.split(/\s+/).some((hash) => published.includes(hash))) {
    return "integrity-mismatch"
  }
  return undefined
}

/**
 * Restore dependency declarations without changing package versions or lock keys.
 *
 * Missing required resolutions prevent a package's repair; incompatible existing
 * versions are reported without resolving new versions.
 * Registry failures reject the whole operation before the caller can write it.
 */
export async function repairLockText(
  lockText: string,
  options: RepairOptions = {},
): Promise<RepairResult> {
  const lock = parseBunLock(lockText)
  const packages = lock.packages ?? {}
  const groups = new Map<string, Set<string>>()
  const patched = lock.patchedDependencies ?? {}
  const skips = new Map<
    string,
    Omit<RepairResult["skippedEntries"][number], "lockKey">
  >()
  const specs = new Map(
    Object.entries(packages).flatMap(([key, entry]) => {
      const spec = isPackageEntry(entry) ? parseResolvedSpec(entry[0]) : null
      return spec ? [[key, spec] as const] : []
    }),
  )

  for (const [lockKey, entry] of Object.entries(packages)) {
    if (!isPackageEntry(entry)) continue
    // Workspace manifests are authoritative locally and have no registry tuple.
    if (entry[0].includes("@workspace:")) continue
    const spec = parseResolvedSpec(entry[0])
    if (isGitPackageEntry(entry) || !spec || !semver.valid(spec.version)) {
      skips.set(lockKey, { reason: "not-registry" })
    } else if (Object.hasOwn(patched, entry[0])) {
      // Registry declarations cannot account for package.json edits in a patch.
      skips.set(lockKey, { reason: "patched" })
    } else {
      const versions = groups.get(spec.name) ?? new Set<string>()
      versions.add(spec.version)
      groups.set(spec.name, versions)
    }
  }

  const metadata = new Map<string, PackageMetadata | null>()
  const queue = [...groups]
  let next = 0
  let completed = 0
  // Bound concurrent packuments and release each package's version history once
  // its locked versions have been collected. Large lockfiles contain many names.
  await Promise.all(
    Array.from({ length: Math.min(8, queue.length) }, async () => {
      while (next < queue.length) {
        const [name, versions] = queue[next++]!
        const cache = createPackumentCache()
        options.onProgress?.({
          phase: "repair",
          current: completed + 1,
          total: queue.length,
          packageName: name,
        })
        for (const version of versions) {
          metadata.set(
            `${name}@${version}`,
            await fetchPackageMetadata(name, version, { ...options, cache }),
          )
        }
        completed++
        options.onProgress?.({
          phase: "repair",
          current: completed,
          total: queue.length,
          packageName: name,
        })
      }
    }),
  )

  const repairedEntries: RepairedEntry[] = []
  const verifiedKeys = new Set<string>()
  for (const [lockKey, entry] of Object.entries(packages)) {
    if (!isPackageEntry(entry) || skips.has(lockKey) || !metadata.has(entry[0]))
      continue
    const meta = metadata.get(entry[0])
    if (!meta) {
      skips.set(lockKey, { reason: "metadata-unavailable" })
      continue
    }
    if (!validMetadata(meta, parseResolvedSpec(entry[0])!.version)) {
      skips.set(lockKey, { reason: "invalid-metadata" })
      continue
    }
    const integrityReason = integritySkipReason(entry[3], meta)
    if (integrityReason) {
      skips.set(lockKey, { reason: integrityReason })
      continue
    }
    const before = packageEntryMeta(entry) ?? {}
    // Keep bin, platform restrictions, bundled, and unknown tuple metadata.
    const after = { ...before }
    for (const field of dependencyFields) {
      const dependencies = Object.entries(meta[field] ?? {}).sort(
        ([left], [right]) => compareStrings(left, right),
      )
      if (dependencies.length) after[field] = Object.fromEntries(dependencies)
      else delete after[field]
    }
    const optionalPeers = Object.entries(meta.peerDependenciesMeta ?? {})
      .filter(
        ([name, value]) =>
          value.optional && Object.hasOwn(meta.peerDependencies ?? {}, name),
      )
      .map(([name]) => name)
      .sort(compareStrings)
    if (optionalPeers.length) after.optionalPeers = optionalPeers
    else delete after.optionalPeers

    // Bun rejects unresolved required edges while parsing, even for non-semver
    // requests. Check each group independently: an optional peer cannot make a
    // runtime dependency optional. No repair changes lock keys, so lookup is stable.
    const requiredNames = new Set([
      ...Object.keys(after.dependencies ?? {}),
      ...Object.keys(after.peerDependencies ?? {}).filter(
        (name) => !optionalPeers.includes(name),
      ),
    ])
    const missingDependencies = [...requiredNames]
      .filter((name) => !resolveDependencyLockKey(lockKey, name, specs))
      .sort(compareStrings)
    if (missingDependencies.length) {
      skips.set(lockKey, {
        reason: "missing-dependencies",
        missingDependencies,
      })
      continue
    }
    verifiedKeys.add(lockKey)

    const changes: RepairChange[] = []
    for (const field of [...dependencyFields, "optionalPeers"] as const) {
      const oldValue =
        field === "optionalPeers"
          ? before.optionalPeers?.toSorted(compareStrings)
          : before[field]
      if (!isDeepStrictEqual(oldValue, after[field])) {
        changes.push({ field, before: before[field], after: after[field] })
      }
    }
    if (changes.length) {
      // Only registry tuples reach here; git tuples keep their second-slot metadata.
      entry[2] = after
      repairedEntries.push({ lockKey, changes })
    }
  }

  const conflicts: RepairConflict[] = []
  for (const lockKey of verifiedKeys) {
    const meta = packageEntryMeta(packages[lockKey]!) ?? {}
    const dependencies = {
      ...meta.dependencies,
      ...meta.optionalDependencies,
      ...meta.peerDependencies,
    }
    for (const [dependencyName, declaredRange] of Object.entries(
      dependencies,
    )) {
      // Absent or incompatible optional peers are legitimate; absent optional
      // dependencies can also be platform-specific and need no installation.
      if (isOptionalPeerDependency(meta, dependencyName)) continue
      const range = effectiveDependencyRange(
        lock,
        dependencyName,
        declaredRange,
      )
      const resolvedKey = resolveDependencyLockKey(
        lockKey,
        dependencyName,
        specs,
      )
      const resolvedVersion = resolvedKey
        ? specs.get(resolvedKey)?.version
        : undefined
      if (
        !resolvedVersion &&
        Object.hasOwn(meta.optionalDependencies ?? {}, dependencyName)
      )
        continue
      if (
        resolvedVersion
          ? evaluateRangeCompatibility(range, resolvedVersion) === false
          : semver.validRange(range)
      ) {
        conflicts.push({ lockKey, dependencyName, range, resolvedVersion })
      }
    }
  }
  return {
    changed: repairedEntries.length > 0,
    lockText: repairedEntries.length ? renderBunLock(lock) : lockText,
    repairedEntries,
    skippedEntries: [...skips].map(([lockKey, skip]) => ({
      lockKey,
      ...skip,
    })),
    conflicts,
  }
}
