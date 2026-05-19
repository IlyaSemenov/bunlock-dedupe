import type { DuplicatePackageInfo, DuplicateVersionInfo } from "./analyze"
import type { SuggestedUpdate } from "./update-analyze"

const DEDUPE_ICON = "⬆️"
const UPDATE_ICON = "⬆️"
const SKIPPED_UPDATE_ICON = "⏩"
const UNLOCK_ICON = "👉"

function formatVersionLine(versionInfo: DuplicateVersionInfo): string {
  if (versionInfo.status === "target") {
    return `✅ ${versionInfo.version}`
  }

  if (versionInfo.status === "can-dedupe") {
    return `${DEDUPE_ICON} ${versionInfo.version} → ${versionInfo.dedupeTargetVersion ?? "?"}`
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
  suggestedUpdates?: SuggestedUpdate[]
  skippedUpdates?: SuggestedUpdate[]
}

type GroupedUpdate = {
  packageName: string
  fromVersion: string
  toVersion: string
  status: "suggested" | "skipped"
  constrainedBy: SuggestedUpdate["constrainedBy"]
  deduplicates: SuggestedUpdate["deduplicates"]
}

function rewriteCannotDedupeAsOrphan(
  duplicates: DuplicatePackageInfo[],
  suggestedUpdates: SuggestedUpdate[],
): DuplicatePackageInfo[] {
  const updateLockKeys = new Set(
    suggestedUpdates.map((u) => u.requesterLockKey),
  )

  return duplicates.map((dup) => ({
    ...dup,
    versions: dup.versions.flatMap((v): DuplicateVersionInfo[] => {
      if (v.status !== "cannot-dedupe") return [v]

      const updatedRequests = v.requests.filter((r) =>
        updateLockKeys.has(r.requesterNodeId),
      )
      if (updatedRequests.length === 0) return [v]

      const remainingRequests = v.requests.filter(
        (r) => !updateLockKeys.has(r.requesterNodeId),
      )
      const rewrittenVersion: DuplicateVersionInfo = {
        ...v,
        status: "orphan" as const,
        dedupeTargetVersion: undefined,
        requests: updatedRequests.map((r) => ({
          ...r,
          requesterWillBeRewritten: true,
        })),
      }

      if (remainingRequests.length === 0) return [rewrittenVersion]

      return [rewrittenVersion, { ...v, requests: remainingRequests }]
    }),
  }))
}

function dedupeByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>()
  const deduped: T[] = []

  for (const item of items) {
    const key = keyFn(item)
    if (seen.has(key)) continue

    seen.add(key)
    deduped.push(item)
  }

  return deduped
}

function updateIdentity(update: SuggestedUpdate): string {
  return `${update.requesterLockKey}\0${update.packageName}\0${update.fromVersion}\0${update.toVersion}`
}

function groupSuggestedUpdates(
  updates: SuggestedUpdate[],
  skippedUpdates: SuggestedUpdate[],
): GroupedUpdate[] {
  const groups = new Map<string, GroupedUpdate>()
  const skippedUpdateIds = new Set(skippedUpdates.map(updateIdentity))

  for (const update of updates) {
    const status = skippedUpdateIds.has(updateIdentity(update))
      ? "skipped"
      : "suggested"
    const key = `${status}\0${update.packageName}\0${update.fromVersion}\0${update.toVersion}`
    const group =
      groups.get(key) ??
      ({
        packageName: update.packageName,
        fromVersion: update.fromVersion,
        toVersion: update.toVersion,
        status,
        constrainedBy: [],
        deduplicates: [],
      } satisfies GroupedUpdate)

    group.constrainedBy.push(...update.constrainedBy)
    group.deduplicates.push(...update.deduplicates)
    groups.set(key, group)
  }

  return [...groups.values()].map((group) => ({
    ...group,
    constrainedBy: dedupeByKey(
      group.constrainedBy,
      (c) => `${c.requesterPath.join("\0")}\0${c.range}`,
    ),
    deduplicates: dedupeByKey(
      group.deduplicates,
      (d) => `${d.name}\0${d.fromVersion}\0${d.targetVersion}`,
    ),
  }))
}

export function formatDuplicatesReport(
  duplicates: DuplicatePackageInfo[],
  options?: FormatDuplicatesReportOptions,
): string {
  const fixableOnly = options?.fixableOnly ?? false
  const suggestedUpdates = options?.suggestedUpdates ?? []
  const skippedUpdates = options?.skippedUpdates ?? []
  const skippedUpdateIds = new Set(skippedUpdates.map(updateIdentity))
  const appliedUpdates = suggestedUpdates.filter(
    (update) => !skippedUpdateIds.has(updateIdentity(update)),
  )

  const transformedDuplicates =
    suggestedUpdates.length > 0
      ? rewriteCannotDedupeAsOrphan(duplicates, appliedUpdates)
      : duplicates

  const filteredDuplicates = fixableOnly
    ? transformedDuplicates
        .filter((duplicate) =>
          duplicate.versions.some(
            (version) =>
              version.status === "can-dedupe" || version.status === "orphan",
          ),
        )
        .map((duplicate) => {
          const versions = duplicate.versions.filter(
            (version) =>
              version.status === "target" ||
              version.status === "can-dedupe" ||
              version.status === "orphan",
          )
          return {
            ...duplicate,
            versions,
          }
        })
    : transformedDuplicates

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
          pathSegments[lastIndex] = `${lastSegment} ${DEDUPE_ICON}`
        }

        const pathText = pathSegments.join(" > ")
        lines.push(`    - ${pathText}: ${request.range}`)
      }
    }

    lines.push("")
  }

  for (const update of groupSuggestedUpdates(
    suggestedUpdates,
    skippedUpdates,
  )) {
    lines.push(update.packageName)
    const updateIcon =
      update.status === "skipped" ? SKIPPED_UPDATE_ICON : UPDATE_ICON
    const statusText =
      update.status === "skipped" ? " (manual update required)" : ""
    lines.push(
      `  ${updateIcon} ${update.fromVersion} → ${update.toVersion}${statusText}`,
    )

    for (const constraint of update.constrainedBy) {
      const requesterText =
        constraint.requesterPath.length > 0
          ? constraint.requesterPath.join(" > ")
          : constraint.requesterLabel
      lines.push(`    - ${requesterText}: ${constraint.range}`)
    }

    for (const dedupe of update.deduplicates) {
      lines.push(
        `  ${UNLOCK_ICON} ${dedupe.name}: ${dedupe.fromVersion} → ${dedupe.targetVersion}`,
      )
    }

    lines.push("")
  }

  if (lines.length === 0) {
    return fixableOnly
      ? "No fixable duplicate packages found in bun.lock."
      : "No duplicate packages found in bun.lock."
  }

  return lines.join("\n").trimEnd()
}
