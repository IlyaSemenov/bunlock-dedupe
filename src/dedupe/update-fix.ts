import semver from "semver"

import { fetchPackageMetadata, type PackageMetadata } from "../registry"
import type { BunPackageEntry, BunPackageMeta } from "./parse"
import {
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
  skipReason: UpdateSkipReason
}

export type UpdateAndDedupeLockResult = {
  changed: boolean
  lockText: string
  updatedEntries: number
  updatedPackages: number
  dedupedEntries: number
  dedupedPackages: number
  suggestedUpdates: SuggestedUpdate[]
  appliedUpdates: SuggestedUpdate[]
  skippedUpdates: SkippedUpdate[]
}

export type UpdateSafetyResult = {
  applicableUpdates: SuggestedUpdate[]
  skippedUpdates: SkippedUpdate[]
}

type ApplicableUpdate = {
  update: SuggestedUpdate
  meta: PackageMetadata
  resolved: string | undefined
  integrity: string
}

function metadataToLockMeta(meta: PackageMetadata): BunPackageMeta {
  const lockMeta: BunPackageMeta = {}
  const optionalPeers = collectOptionalPeerNames(meta)

  if (meta.dependencies) lockMeta.dependencies = meta.dependencies
  if (meta.optionalDependencies) {
    lockMeta.optionalDependencies = meta.optionalDependencies
  }
  if (meta.peerDependencies) lockMeta.peerDependencies = meta.peerDependencies
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

function isPackageEntry(value: unknown): value is BunPackageEntry {
  return Array.isArray(value) && typeof value[0] === "string"
}

function collectPackageSpecs(
  packages: Record<string, BunPackageEntry>,
): Map<string, { name: string; version: string }> {
  const specsByLockKey = new Map<string, { name: string; version: string }>()

  for (const [lockKey, entry] of Object.entries(packages)) {
    if (!isPackageEntry(entry)) continue

    const parsed = parseResolvedSpec(entry[0])
    if (!parsed) continue

    specsByLockKey.set(lockKey, parsed)
  }

  return specsByLockKey
}

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

export async function updateAndDedupeLockText(
  lockText: string,
  options?: UpdateAnalysisOptions,
): Promise<UpdateAndDedupeLockResult> {
  const parsedLock = parseBunLock(lockText)
  const { suggestedUpdates } = await analyzeDuplicatePackagesWithUpdates(
    parsedLock,
    options,
  )
  const packages = parsedLock.packages ?? {}
  parsedLock.packages = packages

  const assessment = await assessSuggestedUpdates(
    packages,
    suggestedUpdates,
    options,
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
