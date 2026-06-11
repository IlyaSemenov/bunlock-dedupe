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
export type {
  SuggestedUpdate,
  UpdateAnalysisOptions,
  UpdateAnalysisResult,
} from "./update-analyze"
export { analyzeDuplicatePackagesWithUpdates } from "./update-analyze"
export type {
  SkippedUpdate,
  UpdateAndDedupeLockResult,
  UpdateSafetyResult,
  UpdateSkipReason,
} from "./update-fix"
export { classifyUpdateSafety, updateAndDedupeLockText } from "./update-fix"
