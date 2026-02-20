export { analyzeDuplicatePackages } from "./analyze"
export { formatDuplicatesReport } from "./format"
export { parseBunLock } from "./parse"
export type { DedupeLockResult } from "./rewrite"
export { dedupeLockText } from "./rewrite"
export type {
  BunLockFile,
  DependencyRequest,
  DuplicatePackageInfo,
  DuplicateVersionInfo,
} from "./types"
