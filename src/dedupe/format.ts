import type { DuplicatePackageInfo, DuplicateVersionInfo } from "./types"

function formatVersionLine(versionInfo: DuplicateVersionInfo): string {
  if (versionInfo.status === "target") {
    return `✅ ${versionInfo.version}`
  }

  if (versionInfo.status === "can-dedupe") {
    return `⬆️ ${versionInfo.version} → ${versionInfo.dedupeTargetVersion ?? "?"}`
  }

  if (versionInfo.status === "cannot-dedupe") {
    return `❌ ${versionInfo.version}`
  }

  return `❓ ${versionInfo.version}`
}

export function formatDuplicatesReport(
  duplicates: DuplicatePackageInfo[],
): string {
  if (duplicates.length === 0) {
    return "No duplicate packages found in bun.lock."
  }

  const lines: string[] = []

  for (const duplicate of duplicates) {
    lines.push(duplicate.name)

    for (const versionInfo of duplicate.versions) {
      lines.push(`  ${formatVersionLine(versionInfo)}`)

      for (const request of versionInfo.requests) {
        const pathText = request.requestPath.join(" > ")
        lines.push(`    - ${pathText}: ${request.range}`)
      }
    }

    lines.push("")
  }

  return lines.join("\n").trimEnd()
}
