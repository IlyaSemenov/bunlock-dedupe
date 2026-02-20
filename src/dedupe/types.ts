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
}

export type BunPackageEntry = [string, string?, BunPackageMeta?, string?]

export type BunLockFile = {
  lockfileVersion?: number
  configVersion?: number
  workspaces?: Record<string, BunLockWorkspace>
  packages?: Record<string, BunPackageEntry>
}

export type ResolvedPackage = {
  lockKey: string
  name: string
  version: string
  dependencies: DependencyMap
  optionalDependencies: DependencyMap
  peerDependencies: DependencyMap
}

export type DependencyRequest = {
  requesterNodeId: string
  requesterLabel: string
  dependencyName: string
  range: string
  resolvedLockKey: string
  resolvedVersion: string
  requestPath: string[]
}

export type DependencyGraph = {
  rootNodeId: string
  workspaceNodeIds: string[]
  nodeLabels: Map<string, string>
  adjacency: Map<string, Set<string>>
  requests: DependencyRequest[]
}

export type DedupeStatus = "target" | "can-dedupe" | "cannot-dedupe" | "unknown"

export type DuplicateVersionInfo = {
  version: string
  status: DedupeStatus
  dedupeTargetVersion?: string
  requests: DependencyRequest[]
}

export type DuplicatePackageInfo = {
  name: string
  targetVersion: string
  versions: DuplicateVersionInfo[]
}
