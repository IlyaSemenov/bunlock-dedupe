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

  if (versionInfo.status === "orphan") {
    return `🗑️ ${versionInfo.version}`
  }

  return `❓ ${versionInfo.version}`
}

type FormatDuplicatesReportOptions = {
  fixableOnly?: boolean
}

export function formatDuplicatesReport(
  duplicates: DuplicatePackageInfo[],
  options?: FormatDuplicatesReportOptions,
): string {
  const fixableOnly = options?.fixableOnly ?? false
  const filteredDuplicates = fixableOnly
    ? duplicates
        .filter((duplicate) =>
          duplicate.versions.some((version) => version.status === "can-dedupe"),
        )
        .map((duplicate) => {
          const versions = duplicate.versions.filter(
            (version) =>
              version.status === "target" || version.status === "can-dedupe",
          )
          return {
            ...duplicate,
            versions,
          }
        })
    : duplicates

  if (filteredDuplicates.length === 0) {
    return fixableOnly
      ? "No fixable duplicate packages found in bun.lock."
      : "No duplicate packages found in bun.lock."
  }

  const lines: string[] = []

  for (const duplicate of filteredDuplicates) {
    lines.push(duplicate.name)

    for (const versionInfo of duplicate.versions) {
      lines.push(`  ${formatVersionLine(versionInfo)}`)

      for (const request of versionInfo.requests) {
        const pathSegments = [...request.requestPath]
        if (
          versionInfo.status === "orphan" &&
          request.requesterWillBeRewritten &&
          pathSegments.length > 0
        ) {
          const lastIndex = pathSegments.length - 1
          const lastSegment = pathSegments[lastIndex]
          pathSegments[lastIndex] = `${lastSegment} ⬆️`
        }

        const pathText = pathSegments.join(" > ")
        lines.push(`    - ${pathText}: ${request.range}`)
      }
    }

    lines.push("")
  }

  return lines.join("\n").trimEnd()
}
