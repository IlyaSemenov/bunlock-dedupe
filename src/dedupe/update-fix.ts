import semver from "semver"

import {
  createPackumentCache,
  fetchPackageMetadata,
  type PackageMetadata,
} from "../registry"
import type { BunPackageEntry, BunPackageMeta } from "./parse"
import {
  isPackageEntry,
  normalizeDependencyMap,
  parseBunLock,
  parseResolvedSpec,
} from "./parse"
import { dedupeLockText, renderBunLock } from "./rewrite"
import {
  analyzeDuplicatePackagesWithUpdates,
  type SuggestedUpdate,
  type UpdateAnalysisOptions,
} from "./update-analyze"

export type UpdateSkipReason =
  | "not-in-lockfile"
  | "metadata-unavailable"
  | "no-integrity"
  | "new-dependencies"

export type SkippedUpdate = SuggestedUpdate & {
  /** Why this suggested update was not written by `--update --fix`. */
  skipReason: UpdateSkipReason
}

export type UpdateAndDedupeLockResult = {
  changed: boolean
  lockText: string
  /** Intermediate package entries updated from registry metadata. */
  updatedEntries: number
  updatedPackages: number
  /** Entries later touched by normal dedupe after updates were applied. */
  dedupedEntries: number
  dedupedPackages: number
  /** All update opportunities found before safety filtering. */
  suggestedUpdates: SuggestedUpdate[]
  /** Suggested updates actually written into the lockfile. */
  appliedUpdates: SuggestedUpdate[]
  /** Suggested updates left for manual/Bun handling. */
  skippedUpdates: SkippedUpdate[]
}

export type UpdateSafetyResult = {
  /** Suggestions that can be applied without adding missing lockfile entries. */
  applicableUpdates: SuggestedUpdate[]
  skippedUpdates: SkippedUpdate[]
}

type ApplicableUpdate = {
  update: SuggestedUpdate
  meta: PackageMetadata
  resolved: string | undefined
  integrity: string
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(
      ([left], [right]) => +(left > right) - +(left < right),
    ),
  )
}

/**
 * Convert npm registry metadata into Bun's compact lockfile metadata shape.
 *
 * npm stores optional peer information under `peerDependenciesMeta`; Bun stores
 * only the optional peer names in `optionalPeers`.
 */
function metadataToLockMeta(meta: PackageMetadata): BunPackageMeta {
  const lockMeta: BunPackageMeta = {}
  const optionalPeers = collectOptionalPeerNames(meta)

  if (meta.dependencies) {
    lockMeta.dependencies = sortRecord(meta.dependencies)
  }
  if (meta.optionalDependencies) {
    lockMeta.optionalDependencies = sortRecord(meta.optionalDependencies)
  }
  if (meta.peerDependencies) {
    lockMeta.peerDependencies = sortRecord(meta.peerDependencies)
  }
  if (optionalPeers.size > 0) lockMeta.optionalPeers = [...optionalPeers]
  if (meta.bin) lockMeta.bin = meta.bin
  if (meta.os) lockMeta.os = meta.os
  if (meta.cpu) lockMeta.cpu = meta.cpu

  return lockMeta
}

function collectOptionalPeerNames(meta: PackageMetadata): Set<string> {
  const optionalPeers = new Set(meta.optionalPeers ?? [])

  for (const [name, peerMeta] of Object.entries(
    meta.peerDependenciesMeta ?? {},
  )) {
    if (peerMeta?.optional === true) optionalPeers.add(name)
  }

  return optionalPeers
}

function collectPackageSpecs(
  packages: Record<string, BunPackageEntry>,
): Map<string, { name: string; version: string }> {
  const specsByLockKey = new Map<string, { name: string; version: string }>()

  for (const [lockKey, entry] of Object.entries(packages)) {
    if (!isPackageEntry(entry)) continue

    const [spec] = entry
    const parsed = parseResolvedSpec(spec)
    if (!parsed) continue

    specsByLockKey.set(lockKey, parsed)
  }

  return specsByLockKey
}

/**
 * Check whether applying an intermediate package update can be done without
 * adding brand-new lockfile entries.
 *
 * `--update --fix` only rewrites existing tuples; if the new package version
 * needs a dependency version that is not already present, the update is left for
 * the user and Bun.
 *
 * @param specsByLockKey Package versions already available somewhere in the
 * current lockfile.
 */
function canReuseExistingDependencyEntries(
  meta: PackageMetadata,
  specsByLockKey: Map<string, { name: string; version: string }>,
): boolean {
  const optionalPeers = collectOptionalPeerNames(meta)
  const requiredDeps = {
    ...normalizeDependencyMap(meta.dependencies),
    ...normalizeDependencyMap(meta.optionalDependencies),
    ...Object.fromEntries(
      Object.entries(normalizeDependencyMap(meta.peerDependencies)).filter(
        ([name]) => !optionalPeers.has(name),
      ),
    ),
  }

  for (const [dependencyName, range] of Object.entries(requiredDeps)) {
    const validRange = semver.validRange(range)
    if (!validRange) return false

    const hasCompatibleEntry = [...specsByLockKey.values()].some(
      (resolvedSpec) =>
        resolvedSpec.name === dependencyName &&
        semver.satisfies(resolvedSpec.version, validRange, {
          includePrerelease: true,
        }),
    )
    if (!hasCompatibleEntry) {
      return false
    }
  }

  return true
}

/**
 * Split suggested updates into the subset that is safe to write and the subset
 * that should be reported as manual work.
 */
async function assessSuggestedUpdates(
  packages: Record<string, BunPackageEntry>,
  updates: SuggestedUpdate[],
  options?: UpdateAnalysisOptions,
): Promise<{
  applicableUpdates: ApplicableUpdate[]
  skippedUpdates: SkippedUpdate[]
}> {
  const applicableUpdates: ApplicableUpdate[] = []
  const skippedUpdates: SkippedUpdate[] = []
  const specsByLockKey = collectPackageSpecs(packages)

  // This pass reports no progress: every packument it needs is already cached
  // from analyze, so each lookup is a cache hit and the remaining work is
  // local. A future network-bound phase can opt in via `options.onProgress`.
  for (const update of updates) {
    const entry = packages[update.requesterLockKey]
    if (!isPackageEntry(entry)) {
      skippedUpdates.push({ ...update, skipReason: "not-in-lockfile" })
      continue
    }

    const meta = await fetchPackageMetadata(
      update.packageName,
      update.toVersion,
      {
        offline: options?.offline,
        cacheDir: options?.cacheDir,
        fetchFn: options?.fetchFn,
        readDirFn: options?.readDirFn,
        readFileFn: options?.readFileFn,
        cache: options?.cache,
      },
    )
    if (!meta) {
      skippedUpdates.push({ ...update, skipReason: "metadata-unavailable" })
      continue
    }

    const [, resolved] = entry
    const nextIntegrity = meta.dist?.integrity
    if (!nextIntegrity) {
      skippedUpdates.push({ ...update, skipReason: "no-integrity" })
      continue
    }
    if (!canReuseExistingDependencyEntries(meta, specsByLockKey)) {
      skippedUpdates.push({ ...update, skipReason: "new-dependencies" })
      continue
    }

    applicableUpdates.push({
      update,
      meta,
      resolved,
      integrity: nextIntegrity,
    })
  }

  return { applicableUpdates, skippedUpdates }
}

function applyApplicableUpdates(
  packages: Record<string, BunPackageEntry>,
  updates: ApplicableUpdate[],
): {
  updatedEntries: number
  updatedPackages: number
  appliedUpdates: SuggestedUpdate[]
} {
  let updatedEntries = 0
  const updatedPackages = new Set<string>()
  const appliedUpdates: SuggestedUpdate[] = []

  for (const { update, meta, resolved, integrity } of updates) {
    packages[update.requesterLockKey] = [
      `${update.packageName}@${update.toVersion}`,
      resolved,
      metadataToLockMeta(meta),
      integrity,
    ] as BunPackageEntry

    updatedEntries += 1
    updatedPackages.add(update.packageName)
    appliedUpdates.push(update)
  }

  return {
    updatedEntries,
    updatedPackages: updatedPackages.size,
    appliedUpdates,
  }
}

export async function classifyUpdateSafety(
  lockText: string,
  updates: SuggestedUpdate[],
  options?: UpdateAnalysisOptions,
): Promise<UpdateSafetyResult> {
  const parsedLock = parseBunLock(lockText)
  const packages = parsedLock.packages ?? {}
  const assessment = await assessSuggestedUpdates(packages, updates, options)

  return {
    applicableUpdates: assessment.applicableUpdates.map(({ update }) => update),
    skippedUpdates: assessment.skippedUpdates,
  }
}

/**
 * Apply safe intermediate updates first, then run the normal dedupe rewrite on
 * the resulting lockfile text.
 *
 * @param lockText Raw `bun.lock` text before update analysis and dedupe.
 */
export async function updateAndDedupeLockText(
  lockText: string,
  options?: UpdateAnalysisOptions,
): Promise<UpdateAndDedupeLockResult> {
  const cache = options?.cache ?? createPackumentCache()
  const sharedOptions: UpdateAnalysisOptions = { ...options, cache }

  const parsedLock = parseBunLock(lockText)
  // Reuse a caller-provided analysis (e.g. when the CLI already ran one for
  // its report) instead of re-running the registry-bound pass twice.
  const suggestedUpdates =
    options?.suggestedUpdates ??
    (await analyzeDuplicatePackagesWithUpdates(parsedLock, sharedOptions))
      .suggestedUpdates
  const packages = parsedLock.packages ?? {}
  parsedLock.packages = packages

  const assessment = await assessSuggestedUpdates(
    packages,
    suggestedUpdates,
    sharedOptions,
  )
  const updateResult = applyApplicableUpdates(
    packages,
    assessment.applicableUpdates,
  )

  const afterUpdatesText =
    updateResult.updatedEntries > 0 ? renderBunLock(parsedLock) : lockText
  const dedupeResult = dedupeLockText(afterUpdatesText)

  return {
    changed: updateResult.updatedEntries > 0 || dedupeResult.changed,
    lockText: dedupeResult.changed ? dedupeResult.lockText : afterUpdatesText,
    updatedEntries: updateResult.updatedEntries,
    updatedPackages: updateResult.updatedPackages,
    dedupedEntries: dedupeResult.touchedEntries,
    dedupedPackages: dedupeResult.rewrittenPackages,
    suggestedUpdates,
    appliedUpdates: updateResult.appliedUpdates,
    skippedUpdates: assessment.skippedUpdates,
  }
}
