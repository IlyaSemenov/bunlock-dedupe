import { compareStrings } from "../utils"
import type { RepairResult, RepairSkipReason } from "./restore"

const skipLabels: Record<RepairSkipReason, string> = {
  "not-registry": "not a registry package",
  patched: "locally patched package",
  "metadata-unavailable": "published version metadata unavailable",
  "invalid-metadata": "invalid published version metadata",
  "no-integrity": "archive integrity unavailable",
  "integrity-mismatch": "archive integrity does not match the registry",
  "missing-dependencies": "restored metadata requires missing dependencies",
}

/** Render restored declarations and remaining issues without implying version updates. */
export function formatRepairReport(
  result: RepairResult,
  lockPath: string,
  fixed = false,
): string {
  const lines: string[] = []
  for (const entry of result.repairedEntries) {
    lines.push(`${entry.lockKey}:`)
    for (const change of entry.changes) {
      if (change.field === "optionalPeers") {
        const before =
          (change.before as string[] | undefined)?.join(", ") || "(none)"
        const after =
          (change.after as string[] | undefined)?.join(", ") || "(none)"
        lines.push(`  optionalPeers: ${before} → ${after}`)
      } else {
        const before = change.before as Record<string, string> | undefined
        const after = change.after as Record<string, string> | undefined
        for (const name of [
          ...new Set([
            ...Object.keys(before ?? {}),
            ...Object.keys(after ?? {}),
          ]),
        ].sort(compareStrings)) {
          if (before?.[name] === after?.[name]) continue
          lines.push(
            `  ${change.field}.${name}: ${before?.[name] ?? "(absent)"} → ${after?.[name] ?? "(absent)"}`,
          )
        }
      }
    }
    lines.push("")
  }
  const count = result.repairedEntries.length
  lines.push(
    count
      ? `${count} package ${count === 1 ? "entry" : "entries"} ${fixed ? "repaired" : "can be repaired"} in ${lockPath}.`
      : `No dependency metadata changes found in ${lockPath}.`,
  )
  if (result.skippedEntries.length) {
    lines.push("", "Skipped entries:")
    for (const entry of result.skippedEntries) {
      const details = entry.missingDependencies?.length
        ? ` (${entry.missingDependencies.join(", ")})`
        : ""
      lines.push(`  - ${entry.lockKey}: ${skipLabels[entry.reason]}${details}`)
    }
  }
  if (result.conflicts.length) {
    lines.push("", "Published ranges not satisfied by the current lockfile:")
    for (const conflict of result.conflicts) {
      lines.push(
        `  - ${conflict.lockKey} > ${conflict.dependencyName}: ${conflict.range} (locked: ${conflict.resolvedVersion ?? "missing"})`,
      )
    }
    lines.push(
      "Repair preserves package versions; resolve these conflicts separately.",
    )
  }
  if (count && !fixed)
    lines.push("", "Run with --repair --fix to restore dependency metadata.")
  return lines.join("\n")
}
