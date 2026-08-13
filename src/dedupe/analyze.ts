import semver from "semver"

import type { BunLockFile, BunPackageMeta } from "./parse"
import {
  isOptionalPeerDependency,
  isPackageEntry,
  normalizeDependencyMap,
  packageEntryMeta,
  parseResolvedSpec,
} from "./parse"
import { compareStrings } from "./utils"

export type ResolvedPackage = {
  /** Lockfile key, e.g. `react` or `some-parent/react`. */
  lockKey: string
  /** Real npm package name parsed from the tuple spec. */
  name: string
  version: string
  dependencies: BunPackageMeta["dependencies"]
  optionalDependencies: BunPackageMeta["optionalDependencies"]
  peerDependencies: BunPackageMeta["peerDependencies"]
  optionalPeers: BunPackageMeta["optionalPeers"]
}

/**
 * One concrete dependency edge after Bun lock-key resolution.
 *
 * `requesterNodeId` may be either a package lock key or a synthetic workspace
 * node id. `resolvedLockKey` is always the package entry that satisfies the
 * request in the current lockfile.
 */
export type DependencyRequest = {
  /** Package lock key or synthetic `workspace:*` node that declares the range. */
  requesterNodeId: string
  /** Human-readable requester label used in reports, e.g. `myapp (workspace)` or `vite`. */
  requesterLabel: string
  dependencyName: string
  /** Declared dependency range exactly as it appears in package metadata. */
  range: string
  /** Global effective range from bun.lock, when present. */
  overrideRange?: string
  /** Lock key selected by the lockfile resolver for this request. */
  resolvedLockKey: string
  resolvedVersion: string
  /** Display path from a workspace to the requester; populated after graph build. */
  requestPath: string[]
}

/**
 * Resolved dependency graph used for both reporting and safety checks.
 *
 * The graph keeps package entries and workspaces in one node space so request
 * paths can explain how a duplicate version is reached from a workspace.
 */
export type DependencyGraph = {
  rootNodeId: string
  workspaceNodeIds: string[]
  nodeLabels: Map<string, string>
  adjacency: Map<string, Set<string>>
  requests: DependencyRequest[]
}

/**
 * Classification of a duplicate version relative to the highest usable target.
 *
 * `orphan` means the version may be incompatible by itself, but every path to
 * it disappears after another dedupe rewrite.
 */
export type DedupeStatus =
  | "target"
  | "can-dedupe"
  | "cannot-dedupe"
  | "unknown"
  | "orphan"

export type DuplicateVersionInfo = {
  version: string
  /** How this version can be treated relative to the package group's targets. */
  status: DedupeStatus
  /** Version to rewrite to when `status` is `can-dedupe`. */
  dedupeTargetVersion?: string
  /** Requests that resolve to this exact version. */
  requests: DependencyRequest[]
}

/**
 * Duplicate package group with one or more resolved versions.
 *
 * `targetVersion` is the highest version seen in the lockfile; lower versions
 * can still become secondary `target` rows when they are needed by lower
 * versions that cannot jump to the highest target.
 */
export type DuplicatePackageInfo = {
  name: string
  /** Highest version seen in the lockfile for this package name. */
  targetVersion: string
  versions: DuplicateVersionInfo[]
}

type RewriteByPackage = Map<string, Map<string, string>>
type TemplatesByPackageAndVersion = Map<string, Map<string, string>>

type OrphanDetectionContext = {
  rewrites: RewriteByPackage
  templates: TemplatesByPackageAndVersion
  packagesByLockKey: Map<string, ResolvedPackage>
  lock: BunLockFile
}

/**
 * Tell nested dependency keys apart from root scoped package keys.
 *
 * For an unscoped dependency, `@scope/name` can match the `/name` suffix even
 * though it is a root package key. A real nested key has another path segment,
 * such as `@scope/requester/name`.
 */
export function isNestedDependencyLockKey(
  lockKey: string,
  dependencyName: string,
): boolean {
  if (!lockKey.endsWith(`/${dependencyName}`)) return false

  return dependencyName.startsWith("@") || !/^@[^/]+\/[^/]+$/.test(lockKey)
}

/**
 * Resolve a dependency the way Bun lock keys are structured:
 * nearest nested `requester/dependency` wins, then the closest
 * ancestor-provided nested entry, then root `dependency`.
 *
 * This is the canonical lock-key resolution shared by graph building, update
 * planning, and update safety checks; only the lock keys matter, so any map
 * keyed by lock key works.
 *
 * @param requesterLockKey Package lock key that owns the dependency. Use
 * `undefined` for workspace/root resolution.
 * @param dependencyName Real npm package name being resolved.
 */
export function resolveDependencyLockKey(
  requesterLockKey: string | undefined,
  dependencyName: string,
  packagesByLockKey: ReadonlyMap<string, unknown>,
): string | undefined {
  if (requesterLockKey) {
    const nestedKey = `${requesterLockKey}/${dependencyName}`
    if (packagesByLockKey.has(nestedKey)) {
      return nestedKey
    }

    let bestCandidate: string | undefined
    let bestPrefixLength = -1
    for (const key of packagesByLockKey.keys()) {
      if (!isNestedDependencyLockKey(key, dependencyName)) {
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

    if (bestCandidate) {
      return bestCandidate
    }
  }

  if (packagesByLockKey.has(dependencyName)) {
    return dependencyName
  }

  if (!requesterLockKey) {
    let uniqueCandidate: string | undefined
    for (const key of packagesByLockKey.keys()) {
      if (!isNestedDependencyLockKey(key, dependencyName)) {
        continue
      }

      if (uniqueCandidate) {
        return undefined
      }

      uniqueCandidate = key
    }

    return uniqueCandidate
  }

  return undefined
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

export function evaluateRangeCompatibility(
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

  return semver.satisfies(targetVersion, validRange)
}

/**
 * Read the exact bare-name override Bun stores for a dependency.
 *
 * Bun 1.3.14 ignores selector keys and omits unsupported nested/path forms,
 * so matching those here would diverge from the package manager.
 */
export function dependencyOverrideRange(
  lock: Pick<BunLockFile, "overrides">,
  dependencyName: string,
): string | undefined {
  const overrides = lock.overrides
  if (!overrides) return undefined
  if (!Object.hasOwn(overrides, dependencyName)) return undefined
  return overrides[dependencyName]
}

/**
 * Return the range Bun actually enforces for a dependency request.
 *
 * An override remains authoritative even when it is not valid semver;
 * compatibility then stays unknown instead of falling back to the declaration.
 */
export function effectiveDependencyRange(
  lock: Pick<BunLockFile, "overrides">,
  dependencyName: string,
  declaredRange: string,
): string {
  const overrideRange = dependencyOverrideRange(lock, dependencyName)
  return overrideRange === undefined ? declaredRange : overrideRange
}

/**
 * Decide whether a resolved dependency should form a reachability edge.
 *
 * Only a known-incompatible optional peer is absent; required dependencies and
 * peers with unknown compatibility stay reachable.
 */
export function isResolvedDependencyReachable(
  lock: Pick<BunLockFile, "overrides">,
  requester: Pick<
    BunPackageMeta,
    | "dependencies"
    | "optionalDependencies"
    | "peerDependencies"
    | "optionalPeers"
  >,
  dependencyName: string,
  resolvedVersion: string,
): boolean {
  if (!isOptionalPeerDependency(requester, dependencyName)) return true

  const range = requester.peerDependencies?.[dependencyName]
  if (!range) return true

  return (
    evaluateRangeCompatibility(
      effectiveDependencyRange(lock, dependencyName, range),
      resolvedVersion,
    ) !== false
  )
}

/** Return the declared range unless bun.lock provides an override. */
export function effectiveRequestRange(request: {
  range: string
  overrideRange?: string
}): string {
  return request.overrideRange === undefined
    ? request.range
    : request.overrideRange
}

/**
 * Evaluate a resolved request against its effective range.
 *
 * `range` remains the package's declaration for reporting, while
 * `overrideRange` controls every compatibility and safety decision.
 */
export function evaluateRequestCompatibility(
  request: Pick<DependencyRequest, "range" | "overrideRange">,
  targetVersion: string,
): boolean | undefined {
  return evaluateRangeCompatibility(
    effectiveRequestRange(request),
    targetVersion,
  )
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
    if (!isPackageEntry(entry)) {
      continue
    }

    const [spec] = entry
    const parsedSpec = parseResolvedSpec(spec)
    if (!parsedSpec) {
      continue
    }

    const metadata = packageEntryMeta(entry) ?? {}

    resolved.set(lockKey, {
      lockKey,
      name: parsedSpec.name,
      version: parsedSpec.version,
      dependencies: normalizeDependencyMap(metadata.dependencies),
      optionalDependencies: normalizeDependencyMap(
        metadata.optionalDependencies,
      ),
      peerDependencies: normalizeDependencyMap(metadata.peerDependencies),
      optionalPeers: Array.isArray(metadata.optionalPeers)
        ? metadata.optionalPeers.filter(
            (name): name is string => typeof name === "string",
          )
        : [],
    })
  }

  return resolved
}

/**
 * Build the request graph from workspaces and package metadata.
 *
 * Non-semver ranges are still represented as requests; compatibility is
 * decided later so reports can explain where unknown ranges came from.
 */
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

    // Keep the declaration for reports and carry Bun's effective constraint
    // separately so an override cannot be mistaken for requester metadata.
    requests.push({
      requesterNodeId,
      requesterLabel: nodeLabels.get(requesterNodeId) ?? requesterNodeId,
      dependencyName,
      range,
      overrideRange: dependencyOverrideRange(lock, dependencyName),
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
      const overrideRange = dependencyOverrideRange(lock, dependencyName)
      const workspaceTargetNodeId =
        overrideRange === undefined &&
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

      const resolvedPackage = packagesByLockKey.get(resolvedNodeId)
      if (
        resolvedPackage &&
        !isResolvedDependencyReachable(
          lock,
          packageEntry,
          dependencyName,
          resolvedPackage.version,
        )
      ) {
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

/**
 * Attach stable human-readable request paths by walking from every workspace.
 *
 * The graph may contain shared subgraphs; the first discovered parent is used
 * only for display, not for dedupe safety decisions.
 */
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

function collectVersionRewrites(
  duplicates: DuplicatePackageInfo[],
): RewriteByPackage {
  const rewrites: RewriteByPackage = new Map()

  for (const duplicate of duplicates) {
    for (const versionInfo of duplicate.versions) {
      if (
        versionInfo.status !== "can-dedupe" ||
        !versionInfo.dedupeTargetVersion ||
        versionInfo.dedupeTargetVersion === versionInfo.version
      ) {
        continue
      }

      const perVersion =
        rewrites.get(duplicate.name) ?? new Map<string, string>()
      perVersion.set(versionInfo.version, versionInfo.dedupeTargetVersion)
      rewrites.set(duplicate.name, perVersion)
    }
  }

  return rewrites
}

function collectTemplateLockKeys(
  packagesByLockKey: Map<string, ResolvedPackage>,
): TemplatesByPackageAndVersion {
  const templates: TemplatesByPackageAndVersion = new Map()

  for (const [lockKey, packageEntry] of packagesByLockKey.entries()) {
    let byVersion = templates.get(packageEntry.name)
    if (!byVersion) {
      byVersion = new Map()
      templates.set(packageEntry.name, byVersion)
    }

    if (!byVersion.has(packageEntry.version) || lockKey === packageEntry.name) {
      byVersion.set(packageEntry.version, lockKey)
    }
  }

  return templates
}

function duplicateVersionKey(name: string, version: string): string {
  return `${name}@${version}`
}

function collectDuplicateStatuses(
  duplicates: DuplicatePackageInfo[],
): Map<string, DedupeStatus> {
  const statuses = new Map<string, DedupeStatus>()

  for (const duplicate of duplicates) {
    for (const versionInfo of duplicate.versions) {
      statuses.set(
        duplicateVersionKey(duplicate.name, versionInfo.version),
        versionInfo.status,
      )
    }
  }

  return statuses
}

function requestHasOrphanRequester(
  request: DependencyRequest,
  context: OrphanDetectionContext,
  duplicateStatuses: Map<string, DedupeStatus>,
): boolean {
  const requesterPackage = context.packagesByLockKey.get(
    request.requesterNodeId,
  )
  if (!requesterPackage) {
    return false
  }

  return (
    duplicateStatuses.get(
      duplicateVersionKey(requesterPackage.name, requesterPackage.version),
    ) === "orphan"
  )
}

/**
 * Checks whether a request will disappear because its requester package is
 * itself rewritten to a target template that no longer asks for this dependency
 * version.
 */
function requestWillBeRemovedByRequesterRewrite(
  request: DependencyRequest,
  requestedVersion: string,
  context: OrphanDetectionContext,
): boolean {
  const requesterPackage = context.packagesByLockKey.get(
    request.requesterNodeId,
  )
  if (!requesterPackage) {
    return false
  }

  const requesterTargetVersion = context.rewrites
    .get(requesterPackage.name)
    ?.get(requesterPackage.version)
  if (
    !requesterTargetVersion ||
    requesterTargetVersion === requesterPackage.version
  ) {
    return false
  }

  const templateLockKey = context.templates
    .get(requesterPackage.name)
    ?.get(requesterTargetVersion)
  if (!templateLockKey) {
    return false
  }

  const targetRequester = context.packagesByLockKey.get(templateLockKey)
  if (!targetRequester) {
    return false
  }

  const targetDependencies = {
    ...targetRequester.dependencies,
    ...targetRequester.optionalDependencies,
    ...targetRequester.peerDependencies,
  }
  const targetRange = targetDependencies[request.dependencyName]
  if (!targetRange) {
    return true
  }

  const compatibility = evaluateRangeCompatibility(
    effectiveDependencyRange(context.lock, request.dependencyName, targetRange),
    requestedVersion,
  )
  return compatibility === false
}

/**
 * Analyze duplicate package versions and classify which versions can be
 * rewritten safely using only entries already present in the lockfile.
 */
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

      const compatibilityChecks = requests.map((request) =>
        evaluateRequestCompatibility(request, toVersion),
      )

      if (compatibilityChecks.some((value) => value === false)) return "cannot"
      // Every inbound request must be checkable before a version can be
      // rewritten; one unknown range keeps the whole version unchanged.
      if (compatibilityChecks.some((value) => value === undefined))
        return "unknown"
      return "can"
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

  const orphanDetectionContext: OrphanDetectionContext = {
    rewrites: collectVersionRewrites(duplicates),
    templates: collectTemplateLockKeys(packagesByLockKey),
    packagesByLockKey,
    lock,
  }

  const duplicateStatuses = collectDuplicateStatuses(duplicates)
  let orphanChanged = true

  while (orphanChanged) {
    orphanChanged = false

    for (const duplicate of duplicates) {
      for (const versionInfo of duplicate.versions) {
        if (
          versionInfo.status !== "cannot-dedupe" &&
          versionInfo.status !== "unknown"
        ) {
          continue
        }

        if (versionInfo.requests.length === 0) {
          continue
        }

        const becomesUnreachable = versionInfo.requests.every(
          (request) =>
            requestWillBeRemovedByRequesterRewrite(
              request,
              versionInfo.version,
              orphanDetectionContext,
            ) ||
            requestHasOrphanRequester(
              request,
              orphanDetectionContext,
              duplicateStatuses,
            ),
        )

        if (!becomesUnreachable) {
          continue
        }

        versionInfo.status = "orphan"
        duplicateStatuses.set(
          duplicateVersionKey(duplicate.name, versionInfo.version),
          "orphan",
        )
        orphanChanged = true
      }
    }
  }

  return duplicates.sort((left, right) => compareStrings(left.name, right.name))
}
