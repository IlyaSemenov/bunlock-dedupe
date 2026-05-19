import semver from "semver"

import { fetchCompatibleVersions, fetchPackageMetadata } from "../registry"
import type { DuplicatePackageInfo } from "./analyze"
import { analyzeDuplicatePackages, evaluateRangeCompatibility } from "./analyze"
import type { BunLockFile } from "./parse"
import { normalizeDependencyMap, parseResolvedSpec } from "./parse"

type VersionUnlock = {
  name: string
  fromVersion: string
  targetVersion: string
}

export type SuggestedUpdate = {
  requesterLockKey: string
  packageName: string
  fromVersion: string
  toVersion: string
  deduplicates: VersionUnlock[]
  constrainedBy: Array<{
    requesterLabel: string
    requesterPath: string[]
    range: string
  }>
}

export type UpdateAnalysisResult = {
  duplicates: DuplicatePackageInfo[]
  suggestedUpdates: SuggestedUpdate[]
}

export type UpdateAnalysisOptions = {
  offline?: boolean
  cacheDir?: string
  fetchFn?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>
  readDirFn?: (path: string) => string[]
  readFileFn?: (path: string) => string
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

function candidateUnlocksDeduplication(
  candidateMeta: {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  },
  blockedDuplicateNames: string[],
  duplicates: DuplicatePackageInfo[],
): boolean {
  const candidateDeps = {
    ...candidateMeta.dependencies,
    ...candidateMeta.optionalDependencies,
    ...candidateMeta.peerDependencies,
  }

  for (const dupName of blockedDuplicateNames) {
    const dupGroup = duplicates.find((d) => d.name === dupName)
    if (!dupGroup) continue

    const candidateRange = candidateDeps[dupName]
    if (candidateRange === undefined) continue

    const compat = evaluateRangeCompatibility(
      candidateRange,
      dupGroup.targetVersion,
    )
    if (compat !== true) return false
  }

  return true
}

function isNonSemverRange(range: string): boolean {
  return (
    range.startsWith("workspace:") ||
    range.startsWith("catalog:") ||
    range.startsWith("link:") ||
    range.startsWith("file:")
  )
}

type RequesterInfo = {
  lockKey: string
  packageName: string
  fromVersion: string
  inboundRanges: Array<{
    requesterLabel: string
    requesterPath: string[]
    range: string
  }>
  blockedDuplicateNames: string[]
}

function collectPackageNamesByLockKey(lock: BunLockFile): Map<string, string> {
  const namesByLockKey = new Map<string, string>()

  for (const [lockKey, entry] of Object.entries(lock.packages ?? {})) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue

    const parsed = parseResolvedSpec(entry[0])
    if (!parsed) continue

    namesByLockKey.set(lockKey, parsed.name)
  }

  return namesByLockKey
}

function resolveDependencyLockKey(
  requesterLockKey: string | undefined,
  dependencyName: string,
  namesByLockKey: Map<string, string>,
): string | undefined {
  if (requesterLockKey) {
    const nestedKey = `${requesterLockKey}/${dependencyName}`
    if (namesByLockKey.has(nestedKey)) return nestedKey
  }

  if (namesByLockKey.has(dependencyName)) return dependencyName

  if (!requesterLockKey) {
    let uniqueCandidate: string | undefined
    for (const [lockKey, packageName] of namesByLockKey) {
      if (packageName !== dependencyName) continue

      if (uniqueCandidate) return undefined

      uniqueCandidate = lockKey
    }

    return uniqueCandidate
  }

  let bestCandidate: string | undefined
  let bestPrefixLength = -1
  for (const [lockKey, packageName] of namesByLockKey) {
    if (packageName !== dependencyName) continue

    const prefix = lockKey.slice(0, -(dependencyName.length + 1))
    if (
      requesterLockKey === prefix ||
      requesterLockKey.startsWith(`${prefix}/`)
    ) {
      if (prefix.length > bestPrefixLength) {
        bestCandidate = lockKey
        bestPrefixLength = prefix.length
      }
    }
  }

  return bestCandidate
}

function addInboundRange(
  inboundByLockKey: Map<
    string,
    Array<{ requesterLabel: string; requesterPath: string[]; range: string }>
  >,
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

function collectInboundRanges(
  requesterMap: Map<string, RequesterInfo>,
  duplicates: DuplicatePackageInfo[],
  lock: BunLockFile,
): Map<
  string,
  Array<{ requesterLabel: string; requesterPath: string[]; range: string }>
> {
  const inboundByLockKey = new Map<
    string,
    Array<{ requesterLabel: string; requesterPath: string[]; range: string }>
  >()
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
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue
    const meta =
      typeof entry[2] === "object" && entry[2] !== null ? entry[2] : {}
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

function pruneUnsuggestible(
  requesterMap: Map<string, RequesterInfo>,
  inboundByLockKey: Map<
    string,
    Array<{ requesterLabel: string; requesterPath: string[]; range: string }>
  >,
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

async function findBestCandidate(
  info: RequesterInfo,
  duplicates: DuplicatePackageInfo[],
  options?: UpdateAnalysisOptions,
): Promise<SuggestedUpdate | null> {
  const ranges = info.inboundRanges.map((r) => r.range)

  const candidates = await fetchCompatibleVersions(info.packageName, {
    ranges,
    offline: options?.offline,
    cacheDir: options?.cacheDir,
    fetchFn: options?.fetchFn,
    readDirFn: options?.readDirFn,
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
      cacheDir: options?.cacheDir,
      fetchFn: options?.fetchFn,
      readDirFn: options?.readDirFn,
      readFileFn: options?.readFileFn,
    })
    if (!meta) continue

    if (
      candidateUnlocksDeduplication(
        meta,
        info.blockedDuplicateNames,
        duplicates,
      )
    ) {
      const unlocked = info.blockedDuplicateNames.map((dupName) => {
        const dup = duplicates.find((d) => d.name === dupName)
        const fromVersion =
          dup?.versions.find((v) =>
            v.requests.some((r) => r.requesterNodeId === info.lockKey),
          )?.version ?? "?"
        return {
          name: dupName,
          fromVersion,
          targetVersion: dup?.targetVersion ?? "?",
        }
      })
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

export async function analyzeDuplicatePackagesWithUpdates(
  lock: BunLockFile,
  options?: UpdateAnalysisOptions,
): Promise<UpdateAnalysisResult> {
  const duplicates = analyzeDuplicatePackages(lock)

  const requesterMap = collectBlockingRequesters(duplicates, lock)
  const inboundByLockKey = collectInboundRanges(requesterMap, duplicates, lock)
  pruneUnsuggestible(requesterMap, inboundByLockKey, duplicates)

  const results = await Promise.all(
    [...requesterMap.values()].map((info) =>
      findBestCandidate(info, duplicates, options),
    ),
  )
  const suggestedUpdates = results.filter(
    (u): u is SuggestedUpdate => u !== null,
  )

  suggestedUpdates.sort((a, b) => {
    if (a.packageName !== b.packageName)
      return a.packageName.localeCompare(b.packageName)
    return a.requesterLockKey.localeCompare(b.requesterLockKey)
  })

  return { duplicates, suggestedUpdates }
}
