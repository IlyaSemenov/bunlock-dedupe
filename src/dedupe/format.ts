import type { DuplicatePackageInfo, DuplicateVersionInfo } from "./analyze"
import type { SuggestedUpdate } from "./update-analyze"
import type { SkippedUpdate, UpdateSkipReason } from "./update-fix"

const DEDUPE_ICON = "⬆️"
const MANUAL_UPDATE_ICON = "✋"

const SKIP_REASON_TEXT: Record<UpdateSkipReason, string> = {
  "not-in-lockfile": "package entry not found in the lockfile",
  "metadata-unavailable": "registry metadata unavailable",
  "no-integrity": "no integrity hash available",
  "new-dependencies": "update adds dependencies missing from the lockfile",
}

type RemovalReason = {
  packageName: string
  fromVersion: string
  toVersion?: string
  requiredBy?: string[]
  skipReason?: UpdateSkipReason
}

type RenderVersionInfo = DuplicateVersionInfo & {
  displayStatus?: "manual-update"
  removedAfter?: RemovalReason[]
  manualUpdateReasons?: RemovalReason[]
}

function formatVersionLine(versionInfo: RenderVersionInfo): string {
  if (versionInfo.displayStatus === "manual-update") {
    return `${MANUAL_UPDATE_ICON} ${versionInfo.version} → ${versionInfo.dedupeTargetVersion ?? "?"}`
  }

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
  includeUnfixable?: boolean
  suggestedUpdates?: SuggestedUpdate[]
  skippedUpdates?: SkippedUpdate[]
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
        requests: updatedRequests,
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

export function updateIdentity(update: SuggestedUpdate): string {
  return `${update.requesterLockKey}\0${update.packageName}\0${update.fromVersion}\0${update.toVersion}`
}

function reasonKey(reason: RemovalReason): string {
  return `${reason.packageName}\0${reason.fromVersion}\0${reason.toVersion ?? ""}`
}

function addReason(
  reasonsByRequester: Map<string, RemovalReason[]>,
  requesterLockKey: string,
  reason: RemovalReason,
): void {
  const reasons = reasonsByRequester.get(requesterLockKey) ?? []
  reasons.push(reason)
  reasonsByRequester.set(requesterLockKey, reasons)
}

function buildVersionReasonsByRequester(
  duplicates: DuplicatePackageInfo[],
  makeReason: (
    duplicate: DuplicatePackageInfo,
    versionInfo: DuplicateVersionInfo,
  ) => RemovalReason | undefined,
): Map<string, RemovalReason[]> {
  const reasonsByRequester = new Map<string, RemovalReason[]>()

  for (const duplicate of duplicates) {
    for (const versionInfo of duplicate.versions) {
      const reason = makeReason(duplicate, versionInfo)
      if (!reason) continue

      for (const request of versionInfo.requests) {
        addReason(reasonsByRequester, request.resolvedLockKey, reason)
      }
    }
  }

  return reasonsByRequester
}

function buildDedupeReasonsByRequester(
  duplicates: DuplicatePackageInfo[],
): Map<string, RemovalReason[]> {
  return buildVersionReasonsByRequester(duplicates, (duplicate, versionInfo) =>
    versionInfo.status === "can-dedupe" && versionInfo.dedupeTargetVersion
      ? {
          packageName: duplicate.name,
          fromVersion: versionInfo.version,
          toVersion: versionInfo.dedupeTargetVersion,
        }
      : undefined,
  )
}

function buildUpdateReasonsByRequester(
  updates: SuggestedUpdate[],
): Map<string, RemovalReason[]> {
  const reasonsByRequester = new Map<string, RemovalReason[]>()

  for (const update of updates) {
    addReason(reasonsByRequester, update.requesterLockKey, {
      packageName: update.packageName,
      fromVersion: update.fromVersion,
      toVersion: update.toVersion,
    })
  }

  return reasonsByRequester
}

function formatConstraint(
  constraint: SuggestedUpdate["constrainedBy"][number],
): string {
  const requesterText =
    constraint.requesterPath.length > 0
      ? constraint.requesterPath.join(" > ")
      : constraint.requesterLabel
  return `${requesterText}: ${constraint.range}`
}

function buildSkippedUpdateReasonsByRequester(
  skippedUpdates: SkippedUpdate[],
): Map<string, RemovalReason[]> {
  const mergedReasons = new Map<string, RemovalReason>()
  const reasonsByRequester = new Map<string, RemovalReason[]>()

  for (const update of skippedUpdates) {
    const key = `${update.packageName}\0${update.fromVersion}\0${update.toVersion}`
    const reason = mergedReasons.get(key) ?? {
      packageName: update.packageName,
      fromVersion: update.fromVersion,
      toVersion: update.toVersion,
      requiredBy: [],
      skipReason: update.skipReason,
    }
    mergedReasons.set(key, reason)

    for (const constraint of update.constrainedBy) {
      const constraintText = formatConstraint(constraint)
      if (!reason.requiredBy?.includes(constraintText)) {
        reason.requiredBy?.push(constraintText)
      }
    }

    addReason(reasonsByRequester, update.requesterLockKey, reason)
  }

  return reasonsByRequester
}

function buildOrphanReasonsByRequester(
  duplicates: DuplicatePackageInfo[],
): Map<string, RemovalReason[]> {
  return buildVersionReasonsByRequester(duplicates, (duplicate, versionInfo) =>
    versionInfo.status === "orphan"
      ? {
          packageName: duplicate.name,
          fromVersion: versionInfo.version,
        }
      : undefined,
  )
}

function reasonsForRequests(
  versionInfo: DuplicateVersionInfo,
  reasonsByRequester: Map<string, RemovalReason[]>,
): RemovalReason[] {
  return dedupeByKey(
    versionInfo.requests.flatMap(
      (request) => reasonsByRequester.get(request.requesterNodeId) ?? [],
    ),
    reasonKey,
  )
}

function hasSkippedUpdateForVersion(
  duplicate: DuplicatePackageInfo,
  versionInfo: DuplicateVersionInfo,
  skippedUpdates: SuggestedUpdate[],
): boolean {
  return skippedUpdates.some((update) =>
    update.deduplicates.some(
      (dedupe) =>
        dedupe.name === duplicate.name &&
        dedupe.fromVersion === versionInfo.version &&
        dedupe.targetVersion === duplicate.targetVersion,
    ),
  )
}

function renderPath(request: DuplicateVersionInfo["requests"][number]): string {
  return request.requestPath.join(" > ")
}

function pushSection(
  lines: string[],
  title: string,
  items: (string | string[])[],
): void {
  if (items.length === 0) return

  lines.push(`    ${title}:`)
  for (const item of items) {
    const [first, ...details] = Array.isArray(item) ? item : [item]
    lines.push(`      - ${first}`)
    for (const detail of details) {
      lines.push(`      ${detail}`)
    }
  }
}

function formatReason(reason: RemovalReason): string {
  if (!reason.toVersion) {
    return `${reason.packageName}: ${reason.fromVersion} is removed`
  }

  return `${reason.packageName}: ${reason.fromVersion} → ${reason.toVersion}`
}

function formatManualReasonLines(reason: RemovalReason): string[] {
  const lines = [formatReason(reason)]

  if (reason.requiredBy && reason.requiredBy.length > 0) {
    lines.push("  required by:")
    for (const requiredBy of reason.requiredBy) {
      lines.push(`    - ${requiredBy}`)
    }
  }
  if (reason.skipReason) {
    lines.push(`  held back: ${SKIP_REASON_TEXT[reason.skipReason]}`)
  }

  return lines
}

export function formatDuplicatesReport(
  duplicates: DuplicatePackageInfo[],
  options?: FormatDuplicatesReportOptions,
): string {
  const includeUnfixable = options?.includeUnfixable ?? false
  const suggestedUpdates = options?.suggestedUpdates ?? []
  const skippedUpdates = options?.skippedUpdates ?? []
  const skippedUpdateIds = new Set(skippedUpdates.map(updateIdentity))
  const appliedUpdates = suggestedUpdates.filter(
    (update) => !skippedUpdateIds.has(updateIdentity(update)),
  )
  const dedupeReasonsByRequester = buildDedupeReasonsByRequester(duplicates)
  const appliedUpdateReasonsByRequester =
    buildUpdateReasonsByRequester(appliedUpdates)
  const skippedUpdateReasonsByRequester =
    buildSkippedUpdateReasonsByRequester(skippedUpdates)

  const transformedDuplicates =
    suggestedUpdates.length > 0
      ? rewriteCannotDedupeAsOrphan(duplicates, appliedUpdates)
      : duplicates
  const orphanReasonsByRequester = buildOrphanReasonsByRequester(
    transformedDuplicates,
  )

  const renderDuplicates = transformedDuplicates.map((duplicate) => ({
    ...duplicate,
    versions: duplicate.versions.map((versionInfo): RenderVersionInfo => {
      if (versionInfo.status === "cannot-dedupe") {
        const manualUpdateReasons = reasonsForRequests(
          versionInfo,
          skippedUpdateReasonsByRequester,
        )

        if (
          manualUpdateReasons.length > 0 &&
          hasSkippedUpdateForVersion(duplicate, versionInfo, skippedUpdates)
        ) {
          return {
            ...versionInfo,
            displayStatus: "manual-update",
            dedupeTargetVersion: duplicate.targetVersion,
            manualUpdateReasons,
          }
        }

        return versionInfo
      }

      if (versionInfo.status !== "orphan") {
        return versionInfo
      }

      const removedAfter = dedupeByKey(
        [
          ...reasonsForRequests(versionInfo, dedupeReasonsByRequester),
          ...reasonsForRequests(versionInfo, appliedUpdateReasonsByRequester),
          ...reasonsForRequests(versionInfo, orphanReasonsByRequester),
        ],
        reasonKey,
      )

      return {
        ...versionInfo,
        removedAfter: removedAfter.length > 0 ? removedAfter : undefined,
      }
    }),
  }))

  const filteredDuplicates = includeUnfixable
    ? renderDuplicates
    : renderDuplicates
        .filter((duplicate) =>
          duplicate.versions.some(
            (version) =>
              version.status === "can-dedupe" ||
              version.status === "orphan" ||
              version.displayStatus === "manual-update",
          ),
        )
        .map((duplicate) => {
          const versions = duplicate.versions.filter(
            (version) =>
              version.status === "target" ||
              version.status === "can-dedupe" ||
              version.status === "orphan" ||
              version.displayStatus === "manual-update",
          )
          return {
            ...duplicate,
            versions,
          }
        })

  const lines: string[] = []

  for (const duplicate of filteredDuplicates) {
    lines.push(`${duplicate.name}:`)

    for (const versionInfo of duplicate.versions) {
      lines.push(`  ${formatVersionLine(versionInfo)}`)

      pushSection(
        lines,
        "used by",
        versionInfo.requests.map(
          (request) => `${renderPath(request)}: ${request.range}`,
        ),
      )
      pushSection(
        lines,
        "removed after",
        (versionInfo.removedAfter ?? []).map(formatReason),
      )
      pushSection(
        lines,
        "can be removed after manual update",
        (versionInfo.manualUpdateReasons ?? []).map(formatManualReasonLines),
      )
    }

    lines.push("")
  }

  if (lines.length === 0) {
    return includeUnfixable
      ? "No duplicate packages found in bun.lock."
      : "No fixable duplicate packages found in bun.lock."
  }

  return lines.join("\n").trimEnd()
}
