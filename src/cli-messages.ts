import type { DuplicatePackageInfo } from "./dedupe/types"

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
