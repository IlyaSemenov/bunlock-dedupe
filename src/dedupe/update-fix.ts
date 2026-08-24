import semver from "semver"

import {
  createPackumentCache,
  fetchPackageMetadata,
  type PackageMetadata,
} from "../registry"
import { effectiveDependencyRange, resolveDependencyLockKey } from "./analyze"
import type { BunLockFile, BunPackageEntry, BunPackageMeta } from "./parse"
import {
  isGitPackageEntry,
  isPackageEntry,
  normalizeDependencyMap,
  parseBunLock,
  parseResolvedSpec,
} from "./parse"
import type { DedupeLockResult } from "./rewrite"
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
  | "unsupported-range"
  | "dependency-conflict"

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
  /** Entries later touched by normal dedupe after updates. */
  dedupedEntries: number
  dedupedPackages: number
  /** Unreachable package entries removed after updates and dedupe. */
  prunedEntries: number
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
 * Effective runtime, optional, and non-optional peer dependency ranges that
 * the lockfile must be able to satisfy for this package version.
 *
 * Non-semver override specifiers stay authoritative, causing the safety pass
 * to reject the update conservatively instead of using the declared range.
 */
function requiredDependencyRanges(
  meta: PackageMetadata,
  lock: Pick<BunLockFile, "overrides">,
): Record<string, string> {
  const optionalPeers = collectOptionalPeerNames(meta)
  const declaredRanges = {
    ...normalizeDependencyMap(meta.dependencies),
    ...normalizeDependencyMap(meta.optionalDependencies),
    ...Object.fromEntries(
      Object.entries(normalizeDependencyMap(meta.peerDependencies)).filter(
        ([name]) => !optionalPeers.has(name),
      ),
    ),
  }

  // Both the global pre-filter and contextual final validation call this
  // helper, so they cannot disagree about candidate metadata under overrides.
  return Object.fromEntries(
    Object.entries(declaredRanges).map(([name, range]) => [
      name,
      effectiveDependencyRange(lock, name, range),
    ]),
  )
}

/**
 * Return why an intermediate package update cannot reuse current entries.
 *
 * `--update --fix` only rewrites existing tuples; if the new package version
 * needs a dependency version that is not already present, the update is left for
 * the user and Bun.
 *
 * This is only a cheap global pre-filter; whether the requester can actually
 * reach a compatible entry is verified contextually by
 * {@link findContextConflicts} after the update is simulated.
 *
 * @param specsByLockKey Package versions already available somewhere in the
 * current lockfile.
 * @returns A precise hold-back reason, or undefined when the pre-filter passes.
 */
function dependencyReuseSkipReason(
  meta: PackageMetadata,
  specsByLockKey: Map<string, { name: string; version: string }>,
  lock: Pick<BunLockFile, "overrides">,
): "new-dependencies" | "unsupported-range" | undefined {
  for (const [dependencyName, range] of Object.entries(
    requiredDependencyRanges(meta, lock),
  )) {
    const validRange = semver.validRange(range)
    if (!validRange) return "unsupported-range"

    const hasCompatibleEntry = [...specsByLockKey.values()].some(
      (resolvedSpec) =>
        resolvedSpec.name === dependencyName &&
        semver.satisfies(resolvedSpec.version, validRange),
    )
    if (!hasCompatibleEntry) {
      return "new-dependencies"
    }
  }

  return undefined
}

/**
 * Split suggested updates into the subset that is safe to write and the subset
 * that should be reported as manual work.
 */
async function assessSuggestedUpdates(
  lock: BunLockFile,
  updates: SuggestedUpdate[],
  options?: UpdateAnalysisOptions,
): Promise<{
  applicableUpdates: ApplicableUpdate[]
  skippedUpdates: SkippedUpdate[]
}> {
  const applicableUpdates: ApplicableUpdate[] = []
  const skippedUpdates: SkippedUpdate[] = []
  const packages = lock.packages ?? {}
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
        refresh: options?.refresh,
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

    const resolved = isGitPackageEntry(entry) ? undefined : entry[1]
    const nextIntegrity = meta.dist?.integrity
    if (!nextIntegrity) {
      skippedUpdates.push({ ...update, skipReason: "no-integrity" })
      continue
    }
    const reuseSkipReason = dependencyReuseSkipReason(
      meta,
      specsByLockKey,
      lock,
    )
    if (reuseSkipReason) {
      skippedUpdates.push({ ...update, skipReason: reuseSkipReason })
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

/**
 * Find applied updates whose new metadata cannot be satisfied from their own
 * resolution context in the final lockfile.
 *
 * {@link canReuseExistingDependencyEntries} accepts a compatible version
 * anywhere in the lockfile, but Bun resolves lock keys contextually: nearest
 * nested `requester/dep` first, then root. A compatible version that lives
 * only under an unrelated package is unreachable from the updated requester,
 * and writing such an update would leave a dependency range that resolves to
 * an incompatible version.
 */
function findContextConflicts(
  lockText: string,
  updates: ApplicableUpdate[],
): Set<ApplicableUpdate> {
  const lock = parseBunLock(lockText)
  const packages = lock.packages ?? {}
  const specsByLockKey = collectPackageSpecs(packages)
  const conflicts = new Set<ApplicableUpdate>()

  for (const applicable of updates) {
    const { update, meta } = applicable
    const entry = packages[update.requesterLockKey]
    // Dedupe may rewrite or prune the updated entry itself; a surviving tuple
    // with a different spec came from elsewhere in the lockfile and its
    // metadata was already consistent there.
    if (
      !isPackageEntry(entry) ||
      entry[0] !== `${update.packageName}@${update.toVersion}`
    ) {
      continue
    }

    for (const [dependencyName, range] of Object.entries(
      requiredDependencyRanges(meta, lock),
    )) {
      const resolvedKey = resolveDependencyLockKey(
        update.requesterLockKey,
        dependencyName,
        specsByLockKey,
      )
      const resolvedSpec = resolvedKey
        ? specsByLockKey.get(resolvedKey)
        : undefined
      const validRange = semver.validRange(range)

      if (
        !resolvedSpec ||
        !validRange ||
        !semver.satisfies(resolvedSpec.version, validRange)
      ) {
        conflicts.add(applicable)
        break
      }
    }
  }

  return conflicts
}

type UpdatePlan = {
  applicableUpdates: ApplicableUpdate[]
  skippedUpdates: SkippedUpdate[]
  updateResult: ReturnType<typeof applyApplicableUpdates>
  afterUpdatesText: string
  dedupeResult: DedupeLockResult
}

/**
 * Assess suggested updates, then apply and dedupe until the resulting lockfile
 * resolves every updated entry's dependencies to compatible versions.
 *
 * Each round applies the remaining candidates to a fresh parse of `lockText`,
 * runs the normal dedupe rewrite, and validates the outcome; updates whose new
 * dependency ranges the final graph cannot satisfy are moved to
 * `skippedUpdates` and the batch is re-applied without them. The loop
 * terminates because every round either ends clean or shrinks the batch.
 */
async function planAndApplyUpdates(
  lockText: string,
  updates: SuggestedUpdate[],
  options?: UpdateAnalysisOptions,
): Promise<UpdatePlan> {
  const assessment = await assessSuggestedUpdates(
    parseBunLock(lockText),
    updates,
    options,
  )
  let applicableUpdates = assessment.applicableUpdates
  const skippedUpdates = [...assessment.skippedUpdates]

  while (true) {
    const parsedLock = parseBunLock(lockText)
    const packages = parsedLock.packages ?? {}
    parsedLock.packages = packages

    const updateResult = applyApplicableUpdates(packages, applicableUpdates)
    const afterUpdatesText =
      updateResult.updatedEntries > 0 ? renderBunLock(parsedLock) : lockText
    const dedupeResult = dedupeLockText(afterUpdatesText)
    const finalText = dedupeResult.changed
      ? dedupeResult.lockText
      : afterUpdatesText

    const conflicts = findContextConflicts(finalText, applicableUpdates)
    if (conflicts.size === 0) {
      return {
        applicableUpdates,
        skippedUpdates,
        updateResult,
        afterUpdatesText,
        dedupeResult,
      }
    }

    for (const conflict of conflicts) {
      skippedUpdates.push({
        ...conflict.update,
        skipReason: "dependency-conflict",
      })
    }
    applicableUpdates = applicableUpdates.filter(
      (applicable) => !conflicts.has(applicable),
    )
  }
}

export async function classifyUpdateSafety(
  lockText: string,
  updates: SuggestedUpdate[],
  options?: UpdateAnalysisOptions,
): Promise<UpdateSafetyResult> {
  const plan = await planAndApplyUpdates(lockText, updates, options)

  return {
    applicableUpdates: plan.applicableUpdates.map(({ update }) => update),
    skippedUpdates: plan.skippedUpdates,
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

  // Reuse a caller-provided analysis (e.g. when the CLI already ran one for
  // its report) instead of re-running the registry-bound pass twice.
  const suggestedUpdates =
    options?.suggestedUpdates ??
    (
      await analyzeDuplicatePackagesWithUpdates(
        parseBunLock(lockText),
        sharedOptions,
      )
    ).suggestedUpdates

  const plan = await planAndApplyUpdates(
    lockText,
    suggestedUpdates,
    sharedOptions,
  )
  const { updateResult, dedupeResult, afterUpdatesText } = plan

  return {
    changed: updateResult.updatedEntries > 0 || dedupeResult.changed,
    lockText: dedupeResult.changed ? dedupeResult.lockText : afterUpdatesText,
    updatedEntries: updateResult.updatedEntries,
    updatedPackages: updateResult.updatedPackages,
    dedupedEntries: dedupeResult.rewrittenEntries,
    dedupedPackages: dedupeResult.rewrittenPackages,
    prunedEntries: dedupeResult.prunedEntries,
    suggestedUpdates,
    appliedUpdates: updateResult.appliedUpdates,
    skippedUpdates: plan.skippedUpdates,
  }
}
