import semver from "semver"

import type { ProgressFn } from "../progress"
import {
  fetchCompatibleVersions,
  fetchPackageMetadata,
  type PackumentCache,
} from "../registry"
import type { DuplicatePackageInfo } from "./analyze"
import {
  analyzeDuplicatePackages,
  evaluateRangeCompatibility,
  resolveDependencyLockKey,
} from "./analyze"
import type { BunLockFile } from "./parse"
import {
  isPackageEntry,
  normalizeDependencyMap,
  packageEntryMeta,
  parseResolvedSpec,
} from "./parse"

type VersionUnlock = {
  name: string
  fromVersion: string
  targetVersion: string
}

type CandidateVersionUnlock = Omit<VersionUnlock, "targetVersion"> & {
  compatibleTargetVersions: string[]
}

/**
 * A single semver range that constrains updates to a blocking package.
 *
 * Each entry comes from a parent (workspace or dependent package) whose own
 * dependency range must remain satisfied by the chosen `toVersion`.
 */
type InboundRangeConstraint = {
  /** Report label for the parent constraint, e.g. `myapp (workspace)` or `vite`. */
  requesterLabel: string
  requesterPath: string[]
  range: string
}

/**
 * A package update that could remove one or more `cannot-dedupe` versions.
 *
 * `requesterLockKey` is the intermediate package entry to update; `constrainedBy`
 * records all inbound ranges that the selected `toVersion` must satisfy.
 */
export type SuggestedUpdate = {
  /** Lock key of the intermediate package entry that should be updated. */
  requesterLockKey: string
  packageName: string
  fromVersion: string
  toVersion: string
  /** Duplicate versions expected to become removable after this update. */
  deduplicates: VersionUnlock[]
  /** Inbound parent/workspace ranges that the selected `toVersion` satisfies. */
  constrainedBy: InboundRangeConstraint[]
}

type CandidateUpdate = Omit<SuggestedUpdate, "deduplicates"> & {
  deduplicates: CandidateVersionUnlock[]
}

function versionUnlockKey(name: string, fromVersion: string): string {
  return `${name}\0${fromVersion}`
}

function requesterUnlockKey(
  requesterLockKey: string,
  name: string,
  fromVersion: string,
): string {
  return `${requesterLockKey}\0${versionUnlockKey(name, fromVersion)}`
}

function isUpdateTarget(
  versionInfo: DuplicatePackageInfo["versions"][number],
  fromVersion: string,
): boolean {
  return (
    (versionInfo.status === "target" ||
      versionInfo.status === "cannot-dedupe") &&
    Boolean(semver.valid(versionInfo.version)) &&
    Boolean(semver.valid(fromVersion)) &&
    semver.gt(versionInfo.version, fromVersion)
  )
}

export function resolveSuggestedUnlock(
  name: string,
  fromVersion: string,
  updates: SuggestedUpdate[],
): { targetVersion: string; requesterLockKeys: Set<string> } | undefined {
  let targetVersion: string | undefined
  const requesterLockKeys = new Set<string>()

  for (const update of updates) {
    const unlock = update.deduplicates.find(
      (candidate) =>
        candidate.name === name && candidate.fromVersion === fromVersion,
    )
    if (!unlock) continue
    // Callers may supply precomputed suggestions, so keep reporting
    // conservative if they disagree on the target for one source version.
    if (targetVersion && targetVersion !== unlock.targetVersion)
      return undefined

    targetVersion = unlock.targetVersion
    requesterLockKeys.add(update.requesterLockKey)
  }

  return targetVersion ? { targetVersion, requesterLockKeys } : undefined
}

export function isSuggestedTarget(
  name: string,
  version: string,
  updates: SuggestedUpdate[],
): boolean {
  return updates.some((update) =>
    update.deduplicates.some(
      (unlock) => unlock.name === name && unlock.targetVersion === version,
    ),
  )
}

export type UpdateAnalysisResult = {
  /** Duplicate analysis used as the basis for suggestions and reporting. */
  duplicates: DuplicatePackageInfo[]
  suggestedUpdates: SuggestedUpdate[]
}

/** Test hooks allow registry and Bun cache access to be mocked deterministically. */
export type UpdateAnalysisOptions = {
  offline?: boolean
  /** Revalidate persistent registry cache entries even when still fresh. */
  refresh?: boolean
  cacheDir?: string
  fetchFn?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>
  readDirFn?: (path: string) => string[]
  readFileFn?: (path: string) => string
  /**
   * Shared packument cache. When omitted, each call uses its own cache; pass a
   * single Map to share network results across analyze + safety passes.
   */
  cache?: PackumentCache
  /**
   * Called as blocking requesters are processed. Use it to render a progress
   * indicator; the callback must not throw or mutate the lockfile.
   */
  onProgress?: ProgressFn
  /**
   * Pre-computed update suggestions. When provided, callers that would
   * otherwise run their own analyze pass (notably `updateAndDedupeLockText`)
   * reuse these instead, skipping duplicate work and duplicate progress.
   */
  suggestedUpdates?: SuggestedUpdate[]
}

/**
 * A package entry that currently blocks dedupe because it requests one or more
 * older duplicate versions.
 */
type RequesterInfo = {
  /** Lock key of the package entry whose own dependency ranges block dedupe. */
  lockKey: string
  packageName: string
  fromVersion: string
  /** Ranges from parents/workspaces that constrain possible updates. */
  inboundRanges: InboundRangeConstraint[]
  /** Duplicate package names currently blocked by this requester. */
  blockedDuplicateNames: string[]
}

function collectBlockedDuplicates(
  requesterLockKey: string,
  duplicates: DuplicatePackageInfo[],
): string[] {
  const blocked: string[] = []
  for (const duplicate of duplicates) {
    for (const versionInfo of duplicate.versions) {
      if (versionInfo.status !== "cannot-dedupe") continue
      for (const request of versionInfo.requests) {
        if (request.requesterNodeId === requesterLockKey) {
          blocked.push(duplicate.name)
          break
        }
      }
    }
  }
  return [...new Set(blocked)]
}

/**
 * A candidate package version is useful only when each blocked dependency can
 * reach at least one target retained by duplicate analysis.
 *
 * @param candidateMeta Registry metadata for a possible newer requester
 * version.
 * @param blockedDuplicateNames Duplicate package names requested too narrowly
 * by the current requester.
 */
function candidateDedupeTargets(
  candidateMeta: {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  },
  requesterLockKey: string,
  blockedDuplicateNames: string[],
  duplicates: DuplicatePackageInfo[],
): CandidateVersionUnlock[] | null {
  const candidateDeps = {
    ...candidateMeta.dependencies,
    ...candidateMeta.optionalDependencies,
    ...candidateMeta.peerDependencies,
  }
  const unlocks: CandidateVersionUnlock[] = []

  for (const dupName of blockedDuplicateNames) {
    const dupGroup = duplicates.find((d) => d.name === dupName)
    if (!dupGroup) return null

    const candidateRange = candidateDeps[dupName]
    const fromVersionInfo = dupGroup.versions.find((version) =>
      version.requests.some(
        (request) => request.requesterNodeId === requesterLockKey,
      ),
    )
    if (!fromVersionInfo) return null

    const fromVersion = fromVersionInfo.version
    const targetVersions = dupGroup.versions
      .filter((version) => isUpdateTarget(version, fromVersion))
      .map((version) => version.version)
    // Dropping the dependency removes its request entirely; otherwise retain
    // every target the candidate accepts for the later requester intersection.
    const compatibleTargetVersions =
      candidateRange === undefined
        ? targetVersions
        : targetVersions.filter(
            (targetVersion) =>
              evaluateRangeCompatibility(candidateRange, targetVersion) ===
              true,
          )
    if (compatibleTargetVersions.length === 0) return null

    unlocks.push({
      name: dupName,
      fromVersion,
      compatibleTargetVersions,
    })
  }

  return unlocks
}

function isNonSemverRange(range: string): boolean {
  return (
    range.startsWith("workspace:") ||
    range.startsWith("catalog:") ||
    range.startsWith("link:") ||
    range.startsWith("file:")
  )
}

function collectPackageNamesByLockKey(lock: BunLockFile): Map<string, string> {
  const namesByLockKey = new Map<string, string>()

  for (const [lockKey, entry] of Object.entries(lock.packages ?? {})) {
    if (!isPackageEntry(entry)) continue

    const [spec] = entry
    const parsed = parseResolvedSpec(spec)
    if (!parsed) continue

    namesByLockKey.set(lockKey, parsed.name)
  }

  return namesByLockKey
}

function addInboundRange(
  inboundByLockKey: Map<string, InboundRangeConstraint[]>,
  lockKey: string,
  requesterLabel: string,
  requesterPath: string[],
  range: string,
): void {
  const arr = inboundByLockKey.get(lockKey) ?? []
  if (
    !arr.some((r) => r.range === range && r.requesterLabel === requesterLabel)
  ) {
    arr.push({ requesterLabel, requesterPath, range })
    inboundByLockKey.set(lockKey, arr)
  }
}

function collectRequesterPaths(
  duplicates: DuplicatePackageInfo[],
): Map<string, string[]> {
  const paths = new Map<string, string[]>()

  for (const duplicate of duplicates) {
    for (const versionInfo of duplicate.versions) {
      if (versionInfo.status !== "cannot-dedupe") continue

      for (const request of versionInfo.requests) {
        if (paths.has(request.requesterNodeId)) continue

        const path =
          request.requestPath.length > 0
            ? request.requestPath.slice(0, -1)
            : [request.requesterLabel]
        paths.set(request.requesterNodeId, path)
      }
    }
  }

  return paths
}

/**
 * Find package entries that are worth checking for newer versions.
 *
 * Workspaces are skipped because `--update --fix` updates lockfile package
 * tuples, not package.json manifests.
 */
function collectBlockingRequesters(
  duplicates: DuplicatePackageInfo[],
  lock: BunLockFile,
): Map<string, RequesterInfo> {
  const requesterMap = new Map<string, RequesterInfo>()

  for (const duplicate of duplicates) {
    for (const versionInfo of duplicate.versions) {
      if (versionInfo.status !== "cannot-dedupe") continue

      for (const request of versionInfo.requests) {
        const lockKey = request.requesterNodeId

        if (lockKey.startsWith("workspace:")) continue
        if (requesterMap.has(lockKey)) continue

        const packageEntry = lock.packages?.[lockKey]
        if (!Array.isArray(packageEntry) || typeof packageEntry[0] !== "string")
          continue

        const spec = packageEntry[0]
        const atIdx = spec.lastIndexOf("@")
        if (atIdx <= 0) continue

        requesterMap.set(lockKey, {
          lockKey,
          packageName: spec.slice(0, atIdx),
          fromVersion: spec.slice(atIdx + 1),
          inboundRanges: [],
          blockedDuplicateNames: [],
        })
      }
    }
  }

  return requesterMap
}

/**
 * Collect all semver ranges that constrain each blocking requester.
 *
 * The selected registry candidate must satisfy these inbound ranges; otherwise
 * updating the intermediate package would violate a parent dependency.
 */
function collectInboundRanges(
  requesterMap: Map<string, RequesterInfo>,
  duplicates: DuplicatePackageInfo[],
  lock: BunLockFile,
): Map<string, InboundRangeConstraint[]> {
  const inboundByLockKey = new Map<string, InboundRangeConstraint[]>()
  const namesByLockKey = collectPackageNamesByLockKey(lock)
  const requesterPaths = collectRequesterPaths(duplicates)

  for (const duplicate of duplicates) {
    for (const versionInfo of duplicate.versions) {
      for (const request of versionInfo.requests) {
        if (!requesterMap.has(request.resolvedLockKey)) continue
        if (isNonSemverRange(request.range)) continue

        addInboundRange(
          inboundByLockKey,
          request.resolvedLockKey,
          request.requesterLabel,
          request.requestPath,
          request.range,
        )
      }
    }
  }

  for (const [entryLockKey, entry] of Object.entries(lock.packages ?? {})) {
    if (!isPackageEntry(entry)) continue
    const meta = packageEntryMeta(entry) ?? {}
    const allDeps = {
      ...normalizeDependencyMap(meta.dependencies),
      ...normalizeDependencyMap(meta.optionalDependencies),
      ...normalizeDependencyMap(meta.peerDependencies),
    }
    for (const [depName, range] of Object.entries(allDeps)) {
      if (typeof range !== "string" || isNonSemverRange(range)) continue

      const resolvedLockKey = resolveDependencyLockKey(
        entryLockKey,
        depName,
        namesByLockKey,
      )
      if (!resolvedLockKey || !requesterMap.has(resolvedLockKey)) continue

      addInboundRange(
        inboundByLockKey,
        resolvedLockKey,
        entryLockKey,
        requesterPaths.get(resolvedLockKey) ?? [entryLockKey],
        range,
      )
    }
  }

  for (const [workspacePath, workspace] of Object.entries(
    lock.workspaces ?? {},
  )) {
    const workspaceName = workspace.name?.trim()
    const workspaceLabel = workspaceName
      ? `${workspaceName} (workspace)`
      : workspacePath
        ? `workspace:${workspacePath}`
        : "workspace:root"
    const allDeps = {
      ...normalizeDependencyMap(workspace.dependencies),
      ...normalizeDependencyMap(workspace.devDependencies),
      ...normalizeDependencyMap(workspace.optionalDependencies),
      ...normalizeDependencyMap(workspace.peerDependencies),
    }
    for (const [depName, range] of Object.entries(allDeps)) {
      if (!range || isNonSemverRange(range)) continue

      const resolvedLockKey =
        resolveDependencyLockKey(workspaceName, depName, namesByLockKey) ??
        resolveDependencyLockKey(undefined, depName, namesByLockKey)
      if (!resolvedLockKey || !requesterMap.has(resolvedLockKey)) continue

      addInboundRange(
        inboundByLockKey,
        resolvedLockKey,
        workspaceLabel,
        requesterPaths.get(resolvedLockKey) ?? [workspaceLabel],
        range,
      )
    }
  }

  return inboundByLockKey
}

/** Drop requesters that either have no blocked duplicates or no usable ranges. */
function pruneUnsuggestible(
  requesterMap: Map<string, RequesterInfo>,
  inboundByLockKey: Map<string, InboundRangeConstraint[]>,
  duplicates: DuplicatePackageInfo[],
): void {
  for (const [lockKey, info] of requesterMap) {
    info.blockedDuplicateNames = collectBlockedDuplicates(lockKey, duplicates)
    info.inboundRanges = inboundByLockKey.get(lockKey) ?? []
  }

  for (const [lockKey, info] of requesterMap) {
    if (
      info.inboundRanges.length === 0 ||
      info.blockedDuplicateNames.length === 0
    ) {
      requesterMap.delete(lockKey)
    }
  }
}

/**
 * Choose the newest registry version that satisfies inbound ranges and changes
 * the requester's dependency ranges enough to unlock dedupe.
 *
 * @param info Blocking package entry plus the parent ranges constraining it.
 */
async function findBestCandidate(
  info: RequesterInfo,
  duplicates: DuplicatePackageInfo[],
  options?: UpdateAnalysisOptions,
): Promise<CandidateUpdate | null> {
  const ranges = info.inboundRanges.map((r) => r.range)

  const candidates = await fetchCompatibleVersions(info.packageName, {
    ranges,
    offline: options?.offline,
    refresh: options?.refresh,
    cacheDir: options?.cacheDir,
    fetchFn: options?.fetchFn,
    readDirFn: options?.readDirFn,
    readFileFn: options?.readFileFn,
    cache: options?.cache,
  })

  const newerCandidates = candidates.filter(
    (v) =>
      v !== info.fromVersion &&
      semver.valid(v) &&
      semver.gt(v, info.fromVersion),
  )

  for (const candidate of newerCandidates) {
    const meta = await fetchPackageMetadata(info.packageName, candidate, {
      offline: options?.offline,
      refresh: options?.refresh,
      cacheDir: options?.cacheDir,
      fetchFn: options?.fetchFn,
      readDirFn: options?.readDirFn,
      readFileFn: options?.readFileFn,
      cache: options?.cache,
    })
    if (!meta) continue

    const unlocked = candidateDedupeTargets(
      meta,
      info.lockKey,
      info.blockedDuplicateNames,
      duplicates,
    )
    if (unlocked) {
      return {
        requesterLockKey: info.lockKey,
        packageName: info.packageName,
        fromVersion: info.fromVersion,
        toVersion: candidate,
        deduplicates: unlocked,
        constrainedBy: info.inboundRanges,
      }
    }
  }

  return null
}

/**
 * Drop suggestions that cannot actually unlock a dedupe.
 *
 * A duplicate version becomes removable only when every inbound request either
 * already accepts the target version or is fixed by an update in the same run.
 * When a co-blocker has no update candidate (no newer version, or the pin
 * lives in a workspace manifest), updating the other blockers would not remove
 * the duplicate — it would only rewrite a requester onto metadata whose
 * dependency range the resulting lockfile cannot satisfy.
 */
function pruneIncompleteUnlocks(
  suggestedUpdates: CandidateUpdate[],
  duplicates: DuplicatePackageInfo[],
): SuggestedUpdate[] {
  const selectedTargets = new Map<string, string>()
  const compatibleTargetsByRequester = new Map<string, Set<string>>()

  for (const update of suggestedUpdates) {
    for (const unlock of update.deduplicates) {
      compatibleTargetsByRequester.set(
        requesterUnlockKey(
          update.requesterLockKey,
          unlock.name,
          unlock.fromVersion,
        ),
        new Set(unlock.compatibleTargetVersions),
      )
    }
  }

  for (const duplicate of duplicates) {
    for (const versionInfo of duplicate.versions) {
      if (versionInfo.status !== "cannot-dedupe") continue

      // Eligible retained versions are already ordered newest first. Choose
      // the first accepted by every unchanged request or proposed update.
      const targetVersion = duplicate.versions
        .filter((candidate) => isUpdateTarget(candidate, versionInfo.version))
        .map((candidate) => candidate.version)
        .find((candidateVersion) =>
          versionInfo.requests.every(
            (request) =>
              evaluateRangeCompatibility(request.range, candidateVersion) ===
                true ||
              compatibleTargetsByRequester
                .get(
                  requesterUnlockKey(
                    request.requesterNodeId,
                    duplicate.name,
                    versionInfo.version,
                  ),
                )
                ?.has(candidateVersion) === true,
          ),
        )

      if (targetVersion) {
        selectedTargets.set(
          versionUnlockKey(duplicate.name, versionInfo.version),
          targetVersion,
        )
      }
    }
  }

  // Strip candidate-only compatibility sets once all requesters converge on
  // one target for each duplicate version.
  return suggestedUpdates
    .map(
      (update): SuggestedUpdate => ({
        ...update,
        deduplicates: update.deduplicates.flatMap(
          ({ compatibleTargetVersions, ...unlock }) => {
            const targetVersion = selectedTargets.get(
              versionUnlockKey(unlock.name, unlock.fromVersion),
            )
            return targetVersion &&
              compatibleTargetVersions.includes(targetVersion)
              ? [{ ...unlock, targetVersion }]
              : []
          },
        ),
      }),
    )
    .filter((update) => update.deduplicates.length > 0)
}

/**
 * Analyze duplicates and suggest intermediate package updates that would make
 * currently incompatible duplicate versions removable.
 *
 * @param lock Parsed lockfile; it is analyzed but not mutated.
 */
export async function analyzeDuplicatePackagesWithUpdates(
  lock: BunLockFile,
  options?: UpdateAnalysisOptions,
): Promise<UpdateAnalysisResult> {
  const duplicates = analyzeDuplicatePackages(lock)

  const requesterMap = collectBlockingRequesters(duplicates, lock)
  const inboundByLockKey = collectInboundRanges(requesterMap, duplicates, lock)
  pruneUnsuggestible(requesterMap, inboundByLockKey, duplicates)

  const requesterList = [...requesterMap.values()]
  let completed = 0
  const results = await Promise.all(
    requesterList.map(async (info) => {
      const result = await findBestCandidate(info, duplicates, options)
      completed += 1
      options?.onProgress?.({
        phase: "analyze",
        current: completed,
        total: requesterList.length,
        packageName: info.packageName,
      })
      return result
    }),
  )
  const suggestedUpdates = pruneIncompleteUnlocks(
    results.filter((u): u is CandidateUpdate => u !== null),
    duplicates,
  )

  suggestedUpdates.sort((a, b) => {
    if (a.packageName !== b.packageName)
      return a.packageName.localeCompare(b.packageName)
    return a.requesterLockKey.localeCompare(b.requesterLockKey)
  })

  return { duplicates, suggestedUpdates }
}
