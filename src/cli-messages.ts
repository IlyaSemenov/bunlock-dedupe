import type { DuplicatePackageInfo, SuggestedUpdate } from "./dedupe"

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `${count} ${one}` : `${count} ${many}`
}

export type AnalyzeSummary =
  | { kind: "clean" }
  | { kind: "no-auto-fix"; totalDuplicatePackages: number }
  | {
      kind: "fixable"
      totalDuplicatePackages: number
      fixablePackages: number
      fixableEntries: number
    }

export type FixSummary =
  | { kind: "clean" }
  | { kind: "no-auto-fix"; totalDuplicatePackages: number }
  | {
      kind: "fixed"
      fixedPackages: number
      fixedEntries: number
      remainingPackages: number
    }

export function buildAnalyzeSummary(
  duplicateGroups: DuplicatePackageInfo[],
  fixablePackages: number,
  fixableEntries: number,
): AnalyzeSummary {
  if (duplicateGroups.length === 0) {
    return { kind: "clean" }
  }
  if (fixablePackages === 0) {
    return {
      kind: "no-auto-fix",
      totalDuplicatePackages: duplicateGroups.length,
    }
  }
  return {
    kind: "fixable",
    totalDuplicatePackages: duplicateGroups.length,
    fixablePackages,
    fixableEntries,
  }
}

export function buildFixSummary(
  duplicateGroups: DuplicatePackageInfo[],
  fixedPackages: number,
  fixedEntries: number,
): FixSummary {
  if (duplicateGroups.length === 0) {
    return { kind: "clean" }
  }
  if (fixedPackages === 0) {
    return {
      kind: "no-auto-fix",
      totalDuplicatePackages: duplicateGroups.length,
    }
  }
  return {
    kind: "fixed",
    fixedPackages,
    fixedEntries,
    remainingPackages: duplicateGroups.length - fixedPackages,
  }
}

export function formatAnalyzeSummary(
  summary: AnalyzeSummary,
  lockPath: string,
): string {
  if (summary.kind === "clean") {
    return `All clean — no duplicate packages in ${lockPath}.`
  }
  if (summary.kind === "no-auto-fix") {
    return `Found ${plural(summary.totalDuplicatePackages, "duplicate package", "duplicate packages")} in ${lockPath}, none can be deduped.`
  }
  const skippedNote =
    summary.totalDuplicatePackages > summary.fixablePackages
      ? ` (${plural(summary.totalDuplicatePackages - summary.fixablePackages, "package", "packages")} cannot be deduped)`
      : ""
  return (
    `Found ${plural(summary.totalDuplicatePackages, "duplicate package", "duplicate packages")} in ${lockPath}.\n` +
    `Ready to dedupe: ${plural(summary.fixablePackages, "package", "packages")}, ${plural(summary.fixableEntries, "entry", "entries")}${skippedNote}.\n` +
    `Run with --fix to apply.`
  )
}

export type UpdateSummary = {
  totalDuplicatePackages: number
  cannotDedupePackages: number
  suggestedUpdateCount: number
  suggestedPackageCount: number
}

export type UpdateFixSummary =
  | {
      kind: "no-change"
      skippedUpdateCount?: number
      skippedPackageCount?: number
      skippedDedupePackageCount?: number
    }
  | {
      kind: "updated"
      updatedEntries: number
      updatedPackages: number
      dedupedEntries: number
      dedupedPackages: number
      skippedUpdateCount?: number
      skippedPackageCount?: number
      skippedDedupePackageCount?: number
    }

export function buildUpdateSummary(
  duplicateGroups: DuplicatePackageInfo[],
  suggestedUpdates: SuggestedUpdate[],
): UpdateSummary {
  const cannotDedupePackages = duplicateGroups.filter((group) =>
    group.versions.some((v) => v.status === "cannot-dedupe"),
  ).length
  const uniquePackages = new Set(suggestedUpdates.map((u) => u.packageName))
    .size
  return {
    totalDuplicatePackages: duplicateGroups.length,
    cannotDedupePackages,
    suggestedUpdateCount: suggestedUpdates.length,
    suggestedPackageCount: uniquePackages,
  }
}

export function formatUpdateSummary(
  summary: UpdateSummary,
  lockPath: string,
): string {
  if (summary.totalDuplicatePackages === 0) {
    return `All clean — no duplicate packages in ${lockPath}.`
  }
  if (summary.cannotDedupePackages === 0) {
    return `Found ${plural(summary.totalDuplicatePackages, "duplicate package", "duplicate packages")} in ${lockPath}, all can be deduped.`
  }
  if (summary.suggestedUpdateCount === 0) {
    return `Found ${plural(summary.totalDuplicatePackages, "duplicate package", "duplicate packages")} in ${lockPath}, ${plural(summary.cannotDedupePackages, "package", "packages")} cannot be deduped. No intermediate updates found.`
  }
  return `Found ${plural(summary.totalDuplicatePackages, "duplicate package", "duplicate packages")} in ${lockPath}${summary.suggestedPackageCount > 0 ? `, ${plural(summary.suggestedPackageCount, "intermediate package", "intermediate packages")} can be updated to unlock deduplication` : ""}.`
}

export function formatUpdateFixSummary(
  summary: UpdateFixSummary,
  lockPath: string,
): string {
  const skippedText =
    summary.skippedUpdateCount && summary.skippedUpdateCount > 0
      ? ` ${plural(summary.skippedDedupePackageCount ?? 0, "more package", "more packages")} could be deduped by manually updating ${plural(summary.skippedPackageCount ?? 0, "intermediate dependency", "intermediate dependencies")}.`
      : ""

  if (summary.kind === "no-change") {
    return `No update fixes applied to ${lockPath}.${skippedText}`
  }

  const updatedText =
    summary.updatedEntries > 0
      ? `Updated ${plural(summary.updatedEntries, "entry", "entries")} across ${plural(summary.updatedPackages, "intermediate package", "intermediate packages")}`
      : "No intermediate updates applied"
  const dedupedText =
    summary.dedupedEntries > 0
      ? `deduped ${plural(summary.dedupedEntries, "entry", "entries")} across ${plural(summary.dedupedPackages, "package", "packages")}`
      : "no dedupe rewrites needed"

  return `${updatedText} and ${dedupedText} in ${lockPath}.${skippedText}`
}

export function formatFixSummary(
  summary: FixSummary,
  lockPath: string,
): string {
  if (summary.kind === "clean") {
    return `All clean — no duplicate packages in ${lockPath}.`
  }
  if (summary.kind === "no-auto-fix") {
    return `Found ${plural(summary.totalDuplicatePackages, "duplicate package", "duplicate packages")} in ${lockPath}, none can be deduped.`
  }
  const remainingNote =
    summary.remainingPackages > 0
      ? ` (${plural(summary.remainingPackages, "package", "packages")} cannot be deduped)`
      : ""
  return `Deduped ${plural(summary.fixedEntries, "entry", "entries")} across ${plural(summary.fixedPackages, "package", "packages")} in ${lockPath}${remainingNote}.`
}
