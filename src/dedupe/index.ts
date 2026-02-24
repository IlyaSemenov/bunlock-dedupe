export type {
  DependencyRequest,
  DuplicatePackageInfo,
  DuplicateVersionInfo,
} from "./analyze"
export { analyzeDuplicatePackages } from "./analyze"
export { formatDuplicatesReport } from "./format"
export type { BunLockFile } from "./parse"
export { parseBunLock } from "./parse"
export type { DedupeLockResult } from "./rewrite"
export { dedupeLockText } from "./rewrite"
