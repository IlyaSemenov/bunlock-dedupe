import type { DuplicatePackageInfo } from "./dedupe/analyze"
import { formatDuplicatesReport } from "./dedupe/format"
import type { SuggestedUpdate } from "./dedupe/update-analyze"

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `${count} ${one}` : `${count} ${many}`
}

// --- Report (body + summary combined) ---

export function formatReportOutput(
  reportBody: string,
  summary: string,
): string {
  return reportBody + "\n\n" + summary
}

export function formatReport(
  duplicates: DuplicatePackageInfo[],
  dedupeResult: { rewrittenPackages: number; touchedEntries: number },
  lockPath: string,
  options?: {
    includeUnfixable?: boolean
    suggestedUpdates?: SuggestedUpdate[]
    skippedUpdates?: SuggestedUpdate[]
  },
): string {
  const summary = buildReportSummary(
    duplicates,
    dedupeResult,
    options?.suggestedUpdates,
  )
  const body = formatDuplicatesReport(duplicates, {
    includeUnfixable: options?.includeUnfixable,
    suggestedUpdates: options?.suggestedUpdates,
    skippedUpdates: options?.skippedUpdates,
  })
  return formatReportOutput(body, formatReportSummary(summary, lockPath))
}

// --- Report summary ---

export type ReportSummary = {
  totalDuplicatePackages: number
  readyPackages: number
  intermediatePackages: number
  cannotDedupePackages: number
}

export function buildReportSummary(
  duplicateGroups: DuplicatePackageInfo[],
  dedupeResult: { rewrittenPackages: number; touchedEntries: number },
  suggestedUpdates?: SuggestedUpdate[],
): ReportSummary {
  const readyPackages = dedupeResult.rewrittenPackages
  const intermediatePackages = suggestedUpdates
    ? new Set(suggestedUpdates.map((u) => u.packageName)).size
    : 0
  const cannotDedupePackages = suggestedUpdates
    ? countCannotDedupePackages(duplicateGroups, suggestedUpdates)
    : duplicateGroups.length - readyPackages

  return {
    totalDuplicatePackages: duplicateGroups.length,
    readyPackages,
    intermediatePackages,
    cannotDedupePackages,
  }
}

export function formatReportSummary(
  summary: ReportSummary,
  lockPath: string,
): string {
  if (summary.totalDuplicatePackages === 0) {
    return `All clean — no duplicate packages in ${lockPath}.`
  }

  const lines: string[] = []
  lines.push(
    `${plural(summary.totalDuplicatePackages, "duplicate package", "duplicate packages")} in ${lockPath}.`,
  )

  if (summary.readyPackages > 0) {
    lines.push(
      `${plural(summary.readyPackages, "package", "packages")} can be deduped.`,
    )
  }

  if (summary.intermediatePackages > 0) {
    lines.push(
      `${plural(summary.intermediatePackages, "intermediate package", "intermediate packages")} can be updated to unlock deduplication.`,
    )
  }

  if (summary.cannotDedupePackages > 0) {
    lines.push(
      `${plural(summary.cannotDedupePackages, "package", "packages")} cannot be deduped.`,
    )
  }

  const canFix = summary.readyPackages > 0
  const canUpdate = summary.intermediatePackages > 0

  if (canFix || canUpdate) {
    lines.push("")
    if (canFix) {
      lines.push("Run with --fix to apply available dedupes.")
    }
    if (canUpdate) {
      lines.push(
        "Run with --update --fix to update intermediate packages and apply dedupes.",
      )
    }
  }

  return lines.join("\n")
}

// --- Internal helpers ---

/**
 * Count packages that have no fixable path even after applying suggested updates.
 * A package is "truly stuck" if:
 *   - it has no can-dedupe or orphan versions (from raw analysis), AND
 *   - not all of its cannot-dedupe requests are covered by suggested updates
 */
export function countCannotDedupePackages(
  duplicates: DuplicatePackageInfo[],
  suggestedUpdates: SuggestedUpdate[],
): number {
  const updateLockKeys = new Set(
    suggestedUpdates.map((u) => u.requesterLockKey),
  )

  return duplicates.filter((group) => {
    const hasFixable = group.versions.some(
      (v) => v.status === "can-dedupe" || v.status === "orphan",
    )
    if (hasFixable) return false

    const cannotDedupeVersions = group.versions.filter(
      (v) => v.status === "cannot-dedupe",
    )
    const allCovered = cannotDedupeVersions.every((v) =>
      v.requests.every((r) => updateLockKeys.has(r.requesterNodeId)),
    )
    return !allCovered
  }).length
}

// --- Fix summary (--fix without --update) ---

export type FixSummary =
  | { kind: "clean" }
  | { kind: "no-auto-fix"; totalDuplicatePackages: number }
  | {
      kind: "fixed"
      fixedPackages: number
      fixedEntries: number
      remainingPackages: number
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

export function formatFixSummary(
  summary: FixSummary,
  lockPath: string,
): string {
  if (summary.kind === "clean") {
    return `All clean — no duplicate packages in ${lockPath}.`
  }
  if (summary.kind === "no-auto-fix") {
    return `${plural(summary.totalDuplicatePackages, "duplicate package", "duplicate packages")} in ${lockPath}.\nNone can be deduped.`
  }
  const remainingNote =
    summary.remainingPackages > 0
      ? `\n${plural(summary.remainingPackages, "package", "packages")} cannot be deduped.`
      : ""
  return `Deduped ${plural(summary.fixedEntries, "entry", "entries")} across ${plural(summary.fixedPackages, "package", "packages")} in ${lockPath}.${remainingNote}`
}

// --- Update fix summary (--update --fix) ---

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

export function formatUpdateFixSummary(
  summary: UpdateFixSummary,
  lockPath: string,
): string {
  const skippedText =
    summary.skippedUpdateCount && summary.skippedUpdateCount > 0
      ? ` ${plural(summary.skippedDedupePackageCount ?? 0, "more package", "more packages")} could be deduped by manually updating ${plural(summary.skippedPackageCount ?? 0, "intermediate dependency", "intermediate dependencies")}.`
      : ""

  if (summary.kind === "no-change") {
    const base = `No update fixes applied to ${lockPath}.`
    return skippedText ? `${base}\n${skippedText.trim()}` : base
  }

  const updatedText =
    summary.updatedEntries > 0
      ? `Updated ${plural(summary.updatedEntries, "entry", "entries")} across ${plural(summary.updatedPackages, "intermediate package", "intermediate packages")}`
      : "No intermediate updates applied"
  const dedupedText =
    summary.dedupedEntries > 0
      ? `deduped ${plural(summary.dedupedEntries, "entry", "entries")} across ${plural(summary.dedupedPackages, "package", "packages")}`
      : "no dedupe rewrites needed"

  const base = `${updatedText} and ${dedupedText} in ${lockPath}.`
  return skippedText ? `${base}\n${skippedText.trim()}` : base
}
