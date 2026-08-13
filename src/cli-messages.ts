import type { DuplicatePackageInfo } from "./dedupe/analyze"
import {
  analyzeDuplicatePackages,
  evaluateRequestCompatibility,
} from "./dedupe/analyze"
import { formatDuplicatesReport, updateIdentity } from "./dedupe/format"
import { parseBunLock } from "./dedupe/parse"
import {
  isSuggestedTarget,
  resolveSuggestedUnlock,
  type SuggestedUpdate,
} from "./dedupe/update-analyze"
import type {
  SkippedUpdate,
  UpdateAndDedupeLockResult,
} from "./dedupe/update-fix"

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `${count} ${one}` : `${count} ${many}`
}

// --- Report (body + summary combined) ---

export function formatReportOutput(
  reportBody: string,
  summary: string,
): string {
  return `${reportBody}\n\n${summary}`
}

export function formatReport(
  duplicates: DuplicatePackageInfo[],
  dedupeResult: {
    rewrittenPackages: number
    prunedEntries?: number
  },
  lockPath: string,
  options?: {
    includeUnfixable?: boolean
    suggestedUpdates?: SuggestedUpdate[]
    skippedUpdates?: SkippedUpdate[]
  },
): string {
  const summary = buildReportSummary(
    duplicates,
    dedupeResult,
    options?.suggestedUpdates,
    options?.skippedUpdates,
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
  cleanupEntries?: number
  intermediatePackages: number
  manualUpdatePackages: number
  manualUpdateDedupePackages: number
  cannotDedupePackages: number
  unknownPackages?: number
}

export function buildReportSummary(
  duplicateGroups: DuplicatePackageInfo[],
  dedupeResult: {
    rewrittenPackages: number
    prunedEntries?: number
  },
  suggestedUpdates?: SuggestedUpdate[],
  skippedUpdates?: SkippedUpdate[],
): ReportSummary {
  const readyPackages = dedupeResult.rewrittenPackages
  const cleanupEntries = dedupeResult.prunedEntries ?? 0
  const skippedUpdateIds = new Set((skippedUpdates ?? []).map(updateIdentity))
  const appliedUpdates = (suggestedUpdates ?? []).filter(
    (update) => !skippedUpdateIds.has(updateIdentity(update)),
  )
  const intermediatePackages = new Set(appliedUpdates.map((u) => u.packageName))
    .size
  const manualUpdatePackages = new Set(
    (skippedUpdates ?? []).map((u) => u.packageName),
  ).size
  const manualUpdateDedupePackages = new Set(
    (skippedUpdates ?? []).flatMap((u) => u.deduplicates.map((d) => d.name)),
  ).size
  const unknownPackages = duplicateGroups.filter((group) => {
    const statuses = new Set(group.versions.map((version) => version.status))
    return (
      statuses.has("unknown") &&
      !statuses.has("can-dedupe") &&
      !statuses.has("orphan") &&
      !statuses.has("cannot-dedupe")
    )
  }).length
  const cannotDedupePackages = suggestedUpdates
    ? countCannotDedupePackages(duplicateGroups, suggestedUpdates)
    : duplicateGroups.length - readyPackages - unknownPackages

  return {
    totalDuplicatePackages: duplicateGroups.length,
    readyPackages,
    cleanupEntries,
    intermediatePackages,
    manualUpdatePackages,
    manualUpdateDedupePackages,
    cannotDedupePackages,
    unknownPackages,
  }
}

export function formatReportSummary(
  summary: ReportSummary,
  lockPath: string,
): string {
  const cleanupEntries = summary.cleanupEntries ?? 0
  if (summary.totalDuplicatePackages === 0 && cleanupEntries === 0) {
    return `All clean — no duplicate packages in ${lockPath}.`
  }

  const lines: string[] = []
  if (summary.totalDuplicatePackages === 0) {
    lines.push(`No duplicate packages in ${lockPath}.`)
  } else {
    lines.push(
      `${plural(summary.totalDuplicatePackages, "duplicate package", "duplicate packages")} in ${lockPath}.`,
    )
  }

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

  if (summary.manualUpdatePackages > 0) {
    lines.push(
      `${plural(summary.manualUpdateDedupePackages, "package", "packages")} can be deduped by manually updating ${plural(summary.manualUpdatePackages, "intermediate dependency", "intermediate dependencies")}.`,
    )
  }

  if (summary.cannotDedupePackages > 0) {
    lines.push(
      `${plural(summary.cannotDedupePackages, "package", "packages")} cannot be deduped.`,
    )
  }

  if ((summary.unknownPackages ?? 0) > 0) {
    lines.push(
      `Compatibility could not be checked automatically for ${plural(
        summary.unknownPackages ?? 0,
        "package",
        "packages",
      )}.`,
    )
  }

  if (cleanupEntries > 0) {
    lines.push(
      `${plural(cleanupEntries, "unreachable entry", "unreachable entries")} can be removed.`,
    )
  }

  const canFix = summary.readyPackages > 0 || cleanupEntries > 0
  const canUpdate = summary.intermediatePackages > 0

  if (canFix || canUpdate) {
    lines.push("")
    if (summary.readyPackages > 0) {
      lines.push(
        cleanupEntries > 0
          ? "Run with --fix to apply available dedupes and remove unreachable entries."
          : "Run with --fix to apply available dedupes.",
      )
    } else if (cleanupEntries > 0) {
      lines.push("Run with --fix to remove unreachable entries.")
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
  return duplicates.filter((group) => {
    const hasFixable = group.versions.some(
      (v) => v.status === "can-dedupe" || v.status === "orphan",
    )
    if (hasFixable) return false

    const cannotDedupeVersions = group.versions.filter(
      (v) =>
        v.status === "cannot-dedupe" &&
        !isSuggestedTarget(group.name, v.version, suggestedUpdates),
    )
    const allCovered = cannotDedupeVersions.every((v) => {
      const unlock = resolveSuggestedUnlock(
        group.name,
        v.version,
        suggestedUpdates,
      )
      if (!unlock) return false

      return v.requests.every(
        (request) =>
          unlock.requesterLockKeys.has(request.requesterNodeId) ||
          evaluateRequestCompatibility(request, unlock.targetVersion) === true,
      )
    })
    return !allCovered
  }).length
}

// --- Fix summary (--fix without --update) ---

export type FixSummary =
  | { kind: "clean" }
  | { kind: "no-auto-fix"; totalDuplicatePackages: number }
  | {
      kind: "cleaned"
      removedEntries: number
      remainingPackages: number
    }
  | {
      kind: "fixed"
      fixedPackages: number
      fixedEntries: number
      removedEntries: number
      remainingPackages: number
    }

export function buildFixSummary({
  duplicateGroups,
  fixedPackages,
  fixedEntries,
  removedEntries,
}: {
  duplicateGroups: DuplicatePackageInfo[]
  fixedPackages: number
  fixedEntries: number
  removedEntries: number
}): FixSummary {
  if (fixedPackages === 0 && removedEntries > 0) {
    return {
      kind: "cleaned",
      removedEntries,
      remainingPackages: duplicateGroups.length,
    }
  }
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
    removedEntries,
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
  if (summary.kind === "cleaned") {
    const remainingNote =
      summary.remainingPackages > 0
        ? `\n${plural(summary.remainingPackages, "package", "packages")} cannot be deduped.`
        : ""
    return `Removed ${plural(summary.removedEntries, "unreachable entry", "unreachable entries")} from ${lockPath}.${remainingNote}`
  }
  const remainingNote =
    summary.remainingPackages > 0
      ? `\n${plural(summary.remainingPackages, "package", "packages")} cannot be deduped.`
      : ""
  const cleanupText =
    summary.removedEntries > 0
      ? ` and removed ${plural(summary.removedEntries, "unreachable entry", "unreachable entries")}`
      : ""
  return `Deduped ${plural(summary.fixedEntries, "entry", "entries")} across ${plural(summary.fixedPackages, "package", "packages")}${cleanupText} in ${lockPath}.${remainingNote}`
}

// --- Update fix report (--update --fix) ---

function countUniqueSkippedDedupePackages(updates: SuggestedUpdate[]): number {
  return new Set(
    updates.flatMap((update) => update.deduplicates.map((d) => d.name)),
  ).size
}

function buildSkippedUpdateSummary(updates: SkippedUpdate[]): {
  skippedUpdateCount: number
  skippedPackageCount: number
  skippedDedupePackageCount: number
} {
  return {
    skippedUpdateCount: updates.length,
    skippedPackageCount: new Set(updates.map((update) => update.packageName))
      .size,
    skippedDedupePackageCount: countUniqueSkippedDedupePackages(updates),
  }
}

/**
 * Build the full `--update --fix` output.
 *
 * The report body describes the lockfile as written: applied updates and
 * dedupes are already reflected in the re-analysis of `result.lockText`, while
 * skipped updates still annotate the blockers they could not fix.
 *
 * @param preUpdateDuplicates Analysis of the lockfile before updates; reused
 * verbatim when nothing changed.
 */
export function formatUpdateFixReport(
  preUpdateDuplicates: DuplicatePackageInfo[],
  result: UpdateAndDedupeLockResult,
  lockPath: string,
  options?: { includeUnfixable?: boolean },
): string {
  const finalDuplicates = result.changed
    ? analyzeDuplicatePackages(parseBunLock(result.lockText))
    : preUpdateDuplicates

  return formatReportOutput(
    formatDuplicatesReport(finalDuplicates, {
      includeUnfixable: options?.includeUnfixable,
      suggestedUpdates: result.skippedUpdates,
      skippedUpdates: result.skippedUpdates,
    }),
    formatUpdateFixSummary(
      result.changed
        ? {
            kind: "updated",
            updatedEntries: result.updatedEntries,
            updatedPackages: result.updatedPackages,
            dedupedEntries: result.dedupedEntries,
            dedupedPackages: result.dedupedPackages,
            prunedEntries: result.prunedEntries,
            ...buildSkippedUpdateSummary(result.skippedUpdates),
          }
        : {
            kind: "no-change",
            ...buildSkippedUpdateSummary(result.skippedUpdates),
          },
      lockPath,
    ),
  )
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
      prunedEntries: number
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

  if (
    summary.updatedEntries === 0 &&
    summary.dedupedPackages === 0 &&
    summary.prunedEntries > 0
  ) {
    const base = `Removed ${plural(summary.prunedEntries, "unreachable entry", "unreachable entries")} from ${lockPath}.`
    return skippedText ? `${base}\n${skippedText.trim()}` : base
  }

  const changes: string[] = []
  if (summary.updatedEntries > 0) {
    changes.push(
      `updated ${plural(summary.updatedEntries, "entry", "entries")} across ${plural(summary.updatedPackages, "intermediate package", "intermediate packages")}`,
    )
  }
  if (summary.dedupedPackages > 0) {
    changes.push(
      `deduped ${plural(summary.dedupedEntries, "entry", "entries")} across ${plural(summary.dedupedPackages, "package", "packages")}`,
    )
  }
  if (summary.prunedEntries > 0) {
    changes.push(
      `removed ${plural(summary.prunedEntries, "unreachable entry", "unreachable entries")}`,
    )
  }

  const [firstChange = "no update fixes applied", ...remainingChanges] = changes
  const changeText = [
    `${firstChange.charAt(0).toUpperCase()}${firstChange.slice(1)}`,
    ...remainingChanges,
  ].join(" and ")
  const base = `${changeText} in ${lockPath}.`
  return skippedText ? `${base}\n${skippedText.trim()}` : base
}
