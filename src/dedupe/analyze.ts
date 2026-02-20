import semver from "semver"

import { normalizeDependencyMap, parseResolvedSpec } from "./parse"
import type {
  BunLockFile,
  BunPackageMeta,
  DependencyGraph,
  DependencyRequest,
  DuplicatePackageInfo,
  DuplicateVersionInfo,
  ResolvedPackage,
} from "./types"
import { compareStrings } from "./utils"

function resolveDependencyLockKey(
  requesterLockKey: string | undefined,
  dependencyName: string,
  packagesByLockKey: Map<string, ResolvedPackage>,
): string | undefined {
  if (requesterLockKey) {
    const nestedKey = `${requesterLockKey}/${dependencyName}`
    if (packagesByLockKey.has(nestedKey)) {
      return nestedKey
    }
  }

  if (packagesByLockKey.has(dependencyName)) {
    return dependencyName
  }

  if (!requesterLockKey) {
    let uniqueCandidate: string | undefined
    for (const key of packagesByLockKey.keys()) {
      if (!key.endsWith(`/${dependencyName}`)) {
        continue
      }

      if (uniqueCandidate) {
        return undefined
      }

      uniqueCandidate = key
    }

    return uniqueCandidate
  }

  let bestCandidate: string | undefined
  let bestPrefixLength = -1
  for (const key of packagesByLockKey.keys()) {
    if (!key.endsWith(`/${dependencyName}`)) {
      continue
    }

    const prefix = key.slice(0, -(dependencyName.length + 1))
    if (
      requesterLockKey === prefix ||
      requesterLockKey.startsWith(`${prefix}/`)
    ) {
      if (prefix.length > bestPrefixLength) {
        bestCandidate = key
        bestPrefixLength = prefix.length
      }
    }
  }

  return bestCandidate
}

function compareVersionDescending(left: string, right: string): number {
  const leftValid = semver.valid(left)
  const rightValid = semver.valid(right)

  if (leftValid && rightValid) {
    return semver.rcompare(left, right)
  }

  if (leftValid) {
    return -1
  }

  if (rightValid) {
    return 1
  }

  return compareStrings(right, left)
}

function evaluateRangeCompatibility(
  range: string,
  targetVersion: string,
): boolean | undefined {
  if (!semver.valid(targetVersion)) {
    return undefined
  }

  const normalized = range.trim()
  if (!normalized) {
    return undefined
  }

  if (
    normalized.startsWith("workspace:") ||
    normalized.startsWith("catalog:") ||
    normalized.startsWith("link:") ||
    normalized.startsWith("file:")
  ) {
    return undefined
  }

  if (semver.valid(normalized)) {
    return semver.eq(targetVersion, normalized)
  }

  const validRange = semver.validRange(normalized)
  if (!validRange) {
    return undefined
  }

  return semver.satisfies(targetVersion, validRange, {
    includePrerelease: true,
  })
}

function workspaceNodeId(workspacePath: string): string {
  return `workspace:${workspacePath || "."}`
}

function ensureNode(adjacency: Map<string, Set<string>>, nodeId: string): void {
  if (!adjacency.has(nodeId)) {
    adjacency.set(nodeId, new Set())
  }
}

function addEdge(
  adjacency: Map<string, Set<string>>,
  fromNodeId: string,
  toNodeId: string,
): void {
  ensureNode(adjacency, fromNodeId)
  ensureNode(adjacency, toNodeId)
  adjacency.get(fromNodeId)?.add(toNodeId)
}

function collectResolvedPackages(
  lock: BunLockFile,
): Map<string, ResolvedPackage> {
  const resolved = new Map<string, ResolvedPackage>()

  for (const [lockKey, entry] of Object.entries(lock.packages ?? {})) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      continue
    }

    const parsedSpec = parseResolvedSpec(entry[0])
    if (!parsedSpec) {
      continue
    }

    const metadata =
      typeof entry[2] === "object" && entry[2] !== null
        ? (entry[2] as BunPackageMeta)
        : {}

    resolved.set(lockKey, {
      lockKey,
      name: parsedSpec.name,
      version: parsedSpec.version,
      dependencies: normalizeDependencyMap(metadata.dependencies),
      optionalDependencies: normalizeDependencyMap(
        metadata.optionalDependencies,
      ),
      peerDependencies: normalizeDependencyMap(metadata.peerDependencies),
    })
  }

  return resolved
}

function collectDependencyGraph(
  lock: BunLockFile,
  packagesByLockKey: Map<string, ResolvedPackage>,
): DependencyGraph {
  const nodeLabels = new Map<string, string>()
  const adjacency = new Map<string, Set<string>>()
  const requests: DependencyRequest[] = []

  for (const packageEntry of packagesByLockKey.values()) {
    nodeLabels.set(packageEntry.lockKey, packageEntry.name)
    ensureNode(adjacency, packageEntry.lockKey)
  }

  const workspaceIdsByPath = new Map<string, string>()
  const workspaceNameToNodeId = new Map<string, string>()
  let rootNodeId: string | undefined

  for (const [workspacePath, workspace] of Object.entries(
    lock.workspaces ?? {},
  )) {
    const nodeId = workspaceNodeId(workspacePath)
    workspaceIdsByPath.set(workspacePath, nodeId)

    const workspaceName = workspace.name?.trim()
    const label = workspaceName
      ? workspaceName
      : workspacePath
        ? `workspace:${workspacePath}`
        : "workspace:root"

    nodeLabels.set(nodeId, label)
    ensureNode(adjacency, nodeId)

    if (workspacePath === "") {
      rootNodeId = nodeId
    }

    if (workspaceName) {
      workspaceNameToNodeId.set(workspaceName, nodeId)
    }
  }

  if (!rootNodeId) {
    const firstWorkspaceNodeId = workspaceIdsByPath.values().next().value
    rootNodeId = firstWorkspaceNodeId ?? workspaceNodeId("")
    if (!nodeLabels.has(rootNodeId)) {
      nodeLabels.set(rootNodeId, "workspace:root")
    }
    ensureNode(adjacency, rootNodeId)
  }

  const addRequest = (
    requesterNodeId: string,
    dependencyName: string,
    range: string,
    resolvedNodeId: string,
  ): void => {
    const resolvedPackage = packagesByLockKey.get(resolvedNodeId)
    if (!resolvedPackage) {
      return
    }

    requests.push({
      requesterNodeId,
      requesterLabel: nodeLabels.get(requesterNodeId) ?? requesterNodeId,
      dependencyName,
      range,
      resolvedLockKey: resolvedNodeId,
      resolvedVersion: resolvedPackage.version,
      requestPath: [],
    })
  }

  for (const [workspacePath, workspace] of Object.entries(
    lock.workspaces ?? {},
  )) {
    const requesterNodeId = workspaceIdsByPath.get(workspacePath)
    if (!requesterNodeId) {
      continue
    }

    const workspaceName = workspace.name?.trim()

    const workspaceDeps = {
      ...normalizeDependencyMap(workspace.dependencies),
      ...normalizeDependencyMap(workspace.devDependencies),
      ...normalizeDependencyMap(workspace.optionalDependencies),
      ...normalizeDependencyMap(workspace.peerDependencies),
    }

    for (const [dependencyName, range] of Object.entries(workspaceDeps)) {
      const workspaceTargetNodeId =
        range.startsWith("workspace:") &&
        workspaceNameToNodeId.has(dependencyName)
          ? workspaceNameToNodeId.get(dependencyName)
          : undefined

      const resolvedNodeId =
        workspaceTargetNodeId ??
        resolveDependencyLockKey(
          workspaceName,
          dependencyName,
          packagesByLockKey,
        ) ??
        resolveDependencyLockKey(undefined, dependencyName, packagesByLockKey)

      if (!resolvedNodeId) {
        continue
      }

      addEdge(adjacency, requesterNodeId, resolvedNodeId)
      addRequest(requesterNodeId, dependencyName, range, resolvedNodeId)
    }
  }

  for (const packageEntry of packagesByLockKey.values()) {
    const dependencies = {
      ...packageEntry.dependencies,
      ...packageEntry.optionalDependencies,
      ...packageEntry.peerDependencies,
    }

    for (const [dependencyName, range] of Object.entries(dependencies)) {
      const resolvedNodeId = resolveDependencyLockKey(
        packageEntry.lockKey,
        dependencyName,
        packagesByLockKey,
      )
      if (!resolvedNodeId) {
        continue
      }

      addEdge(adjacency, packageEntry.lockKey, resolvedNodeId)
      addRequest(packageEntry.lockKey, dependencyName, range, resolvedNodeId)
    }
  }

  return {
    rootNodeId,
    workspaceNodeIds: [...workspaceIdsByPath.values()],
    nodeLabels,
    adjacency,
    requests,
  }
}

function attachRequestPaths(graph: DependencyGraph): void {
  const parents = new Map<string, string | undefined>()
  const traverseFrom = (startNodeId: string): void => {
    if (parents.has(startNodeId)) {
      return
    }

    const queue: string[] = [startNodeId]
    let head = 0
    parents.set(startNodeId, undefined)

    while (head < queue.length) {
      const current = queue[head++]
      if (current === undefined) {
        continue
      }

      const children = graph.adjacency.get(current)
      if (!children) {
        continue
      }

      for (const child of children) {
        if (parents.has(child)) {
          continue
        }

        parents.set(child, current)
        queue.push(child)
      }
    }
  }

  traverseFrom(graph.rootNodeId)

  for (const workspaceNodeId of graph.workspaceNodeIds) {
    traverseFrom(workspaceNodeId)
  }

  const buildPathLabels = (nodeId: string): string[] => {
    if (!parents.has(nodeId)) {
      return [graph.nodeLabels.get(nodeId) ?? nodeId]
    }

    const pathNodeIds: string[] = []
    let cursor: string | undefined = nodeId
    while (cursor) {
      pathNodeIds.push(cursor)
      cursor = parents.get(cursor)
    }

    pathNodeIds.reverse()
    return pathNodeIds.map(
      (pathNodeId) => graph.nodeLabels.get(pathNodeId) ?? pathNodeId,
    )
  }

  for (const request of graph.requests) {
    request.requestPath = buildPathLabels(request.requesterNodeId)
  }
}

export function analyzeDuplicatePackages(
  lock: BunLockFile,
): DuplicatePackageInfo[] {
  const packagesByLockKey = collectResolvedPackages(lock)
  const graph = collectDependencyGraph(lock, packagesByLockKey)
  attachRequestPaths(graph)

  const packagesByName = new Map<string, ResolvedPackage[]>()
  for (const packageEntry of packagesByLockKey.values()) {
    const current = packagesByName.get(packageEntry.name) ?? []
    current.push(packageEntry)
    packagesByName.set(packageEntry.name, current)
  }

  const requestIndex = new Map<string, Map<string, DependencyRequest[]>>()
  for (const request of graph.requests) {
    let byVersion = requestIndex.get(request.dependencyName)
    if (!byVersion) {
      byVersion = new Map()
      requestIndex.set(request.dependencyName, byVersion)
    }
    const existing = byVersion.get(request.resolvedVersion)
    if (existing) {
      existing.push(request)
    } else {
      byVersion.set(request.resolvedVersion, [request])
    }
  }

  const duplicates: DuplicatePackageInfo[] = []
  for (const [name, packageEntries] of packagesByName.entries()) {
    const versionSet = new Set(packageEntries.map((entry) => entry.version))
    if (versionSet.size <= 1) {
      continue
    }

    const versions = [...versionSet].sort(compareVersionDescending)
    const targetVersion = versions[0]
    if (!targetVersion) {
      continue
    }

    const requestsByVersion = new Map<string, DependencyRequest[]>()
    for (const version of versions) {
      const requests = [...(requestIndex.get(name)?.get(version) ?? [])].sort(
        (left, right) => {
          const lp = left.requestPath
          const rp = right.requestPath
          for (let i = 0; i < Math.min(lp.length, rp.length); i++) {
            const cmp = compareStrings(lp[i] ?? "", rp[i] ?? "")
            if (cmp !== 0) return cmp
          }
          if (lp.length !== rp.length) return lp.length - rp.length
          return compareStrings(left.range, right.range)
        },
      )

      requestsByVersion.set(version, requests)
    }

    const compatibilityByVersion = new Map<
      string,
      Map<string, "can" | "cannot" | "unknown">
    >()

    const evaluateCompatibility = (
      fromVersion: string,
      toVersion: string,
    ): "can" | "cannot" | "unknown" => {
      const requests = requestsByVersion.get(fromVersion) ?? []
      if (requests.length === 0) {
        return "unknown"
      }

      const compatibilityChecks = requests
        .map((request) => evaluateRangeCompatibility(request.range, toVersion))
        .filter((value): value is boolean => value !== undefined)

      if (compatibilityChecks.length === 0) {
        return "unknown"
      }

      return compatibilityChecks.every(Boolean) ? "can" : "cannot"
    }

    for (const [versionIndex, version] of versions.entries()) {
      const states = new Map<string, "can" | "cannot" | "unknown">()

      for (const higherVersion of versions.slice(0, versionIndex)) {
        states.set(higherVersion, evaluateCompatibility(version, higherVersion))
      }

      compatibilityByVersion.set(version, states)
    }

    const targetVersions = new Set<string>()
    targetVersions.add(targetVersion)

    const versionRows: DuplicateVersionInfo[] = []
    for (const [versionIndex, version] of versions.entries()) {
      const requests = requestsByVersion.get(version) ?? []

      if (versionIndex === 0) {
        versionRows.push({
          version,
          status: "target",
          requests,
        })
        continue
      }

      const compatibleTargetVersion = versions
        .slice(0, versionIndex)
        .find(
          (candidateVersion) =>
            targetVersions.has(candidateVersion) &&
            compatibilityByVersion.get(version)?.get(candidateVersion) ===
              "can",
        )

      if (compatibleTargetVersion) {
        versionRows.push({
          version,
          status: "can-dedupe",
          dedupeTargetVersion: compatibleTargetVersion,
          requests,
        })
        continue
      }

      const hasDeterministicChecksAgainstTargets = [...targetVersions].some(
        (candidateVersion) =>
          compatibilityByVersion.get(version)?.get(candidateVersion) !==
          "unknown",
      )

      const hasIncomingFromLowerNeedingTarget = versions
        .slice(versionIndex + 1)
        .some((lowerVersion, lowerOffset) => {
          if (
            compatibilityByVersion.get(lowerVersion)?.get(version) !== "can"
          ) {
            return false
          }

          const lowerIndex = versionIndex + 1 + lowerOffset
          const canLowerVersionDedupeToExistingTarget = versions
            .slice(0, lowerIndex)
            .some(
              (candidateVersion) =>
                targetVersions.has(candidateVersion) &&
                compatibilityByVersion
                  .get(lowerVersion)
                  ?.get(candidateVersion) === "can",
            )

          return !canLowerVersionDedupeToExistingTarget
        })

      if (hasIncomingFromLowerNeedingTarget) {
        targetVersions.add(version)
        versionRows.push({
          version,
          status: "target",
          requests,
        })
        continue
      }

      if (!hasDeterministicChecksAgainstTargets) {
        versionRows.push({
          version,
          status: "unknown",
          requests,
        })
        continue
      }

      versionRows.push({
        version,
        status: "cannot-dedupe",
        requests,
      })
    }

    duplicates.push({
      name,
      targetVersion,
      versions: versionRows,
    })
  }

  return duplicates.sort((left, right) => compareStrings(left.name, right.name))
}
