import { analyzeDuplicatePackages } from "./analyze"
import { parseBunLock, parseResolvedSpec } from "./parse"
import type {
  BunLockFile,
  BunPackageEntry,
  DuplicatePackageInfo,
} from "./types"
import { compareLockKeysByNesting } from "./utils"

type RewriteByPackage = Map<string, Map<string, string>>
type TemplatesByPackage = Map<string, Map<string, BunPackageEntry>>

export type DedupeLockResult = {
  changed: boolean
  lockText: string
  touchedEntries: number
  rewrittenPackages: number
}

function collectVersionRewrites(
  duplicates: DuplicatePackageInfo[],
): RewriteByPackage {
  const rewrites: RewriteByPackage = new Map()

  for (const duplicate of duplicates) {
    for (const versionInfo of duplicate.versions) {
      if (
        versionInfo.status !== "can-dedupe" ||
        !versionInfo.dedupeTargetVersion ||
        versionInfo.dedupeTargetVersion === versionInfo.version
      ) {
        continue
      }

      const perVersion =
        rewrites.get(duplicate.name) ?? new Map<string, string>()
      perVersion.set(versionInfo.version, versionInfo.dedupeTargetVersion)
      rewrites.set(duplicate.name, perVersion)
    }
  }

  return rewrites
}

function collectPackageIndex(packages: Record<string, BunPackageEntry>): {
  templates: TemplatesByPackage
  rootVersions: Map<string, string>
} {
  const templates: TemplatesByPackage = new Map()
  const rootVersions = new Map<string, string>()

  for (const [lockKey, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      continue
    }

    const parsed = parseResolvedSpec(entry[0])
    if (!parsed) {
      continue
    }

    let byVersion = templates.get(parsed.name)
    if (!byVersion) {
      byVersion = new Map()
      templates.set(parsed.name, byVersion)
    }
    if (!byVersion.has(parsed.version) || lockKey === parsed.name) {
      byVersion.set(parsed.version, entry)
    }

    if (lockKey === parsed.name) {
      rootVersions.set(parsed.name, parsed.version)
    }
  }

  return { templates, rootVersions }
}

function rewriteEntries(
  packages: Record<string, BunPackageEntry>,
  rewrites: RewriteByPackage,
): { touchedEntries: number; rewrittenPackages: number } {
  const { templates, rootVersions } = collectPackageIndex(packages)
  const touchedPackageNames = new Set<string>()
  let touchedEntries = 0

  for (const lockKey of Object.keys(packages)) {
    const entry = packages[lockKey]
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      continue
    }

    const parsed = parseResolvedSpec(entry[0])
    if (!parsed) {
      continue
    }

    const targetVersion = rewrites.get(parsed.name)?.get(parsed.version)
    if (!targetVersion || targetVersion === parsed.version) {
      continue
    }

    const replacement = templates.get(parsed.name)?.get(targetVersion)
    if (!replacement) {
      continue
    }

    if (
      lockKey !== parsed.name &&
      rootVersions.get(parsed.name) === targetVersion
    ) {
      const prefix = `${lockKey}/`
      for (const candidateKey of Object.keys(packages)) {
        if (candidateKey === lockKey || candidateKey.startsWith(prefix)) {
          delete packages[candidateKey]
          touchedEntries += 1
        }
      }
      touchedPackageNames.add(parsed.name)
      continue
    }

    const [spec, resolved, meta, integrity] = replacement
    packages[lockKey] = [
      spec,
      resolved,
      meta !== undefined ? { ...meta } : undefined,
      integrity,
    ] as BunPackageEntry
    touchedEntries += 1
    touchedPackageNames.add(parsed.name)
  }

  return {
    touchedEntries,
    rewrittenPackages: touchedPackageNames.size,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function renderInlineValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => renderInlineValue(item)).join(", ")}]`
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(
        ([key, item]) => `${JSON.stringify(key)}: ${renderInlineValue(item)}`,
      )

    if (entries.length === 0) {
      return "{}"
    }

    return `{ ${entries.join(", ")} }`
  }

  const serialized = JSON.stringify(value)
  return serialized === undefined ? "null" : serialized
}

function renderPackagesPropertyLines(
  key: string,
  value: Record<string, unknown>,
  indentLevel: number,
  trailingComma: boolean,
): string[] {
  const indent = " ".repeat(indentLevel)
  const entryIndent = " ".repeat(indentLevel + 2)
  const lines = [`${indent}${JSON.stringify(key)}: {`]
  const packageEntries = Object.entries(value)
    .filter(([, packageEntry]) => packageEntry !== undefined)
    .sort(([left], [right]) => compareLockKeysByNesting(left, right))

  for (const [index, [lockKey, packageEntry]] of packageEntries.entries()) {
    lines.push(
      `${entryIndent}${JSON.stringify(lockKey)}: ${renderInlineValue(packageEntry)},`,
    )
    if (index < packageEntries.length - 1) {
      lines.push("")
    }
  }

  lines.push(`${indent}}${trailingComma ? "," : ""}`)
  return lines
}

function renderObjectLines(
  value: Record<string, unknown>,
  indentLevel: number,
  allowPackagesFormatting: boolean,
): string[] {
  const indent = " ".repeat(indentLevel)
  const propertyIndent = " ".repeat(indentLevel + 2)
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)

  if (entries.length === 0) {
    return [`${indent}{}`]
  }

  const lines = [`${indent}{`]
  for (const [index, [key, item]] of entries.entries()) {
    const trailingComma = index < entries.length - 1

    if (allowPackagesFormatting && key === "packages" && isRecord(item)) {
      lines.push(
        ...renderPackagesPropertyLines(
          key,
          item,
          indentLevel + 2,
          trailingComma,
        ),
      )
      continue
    }

    if (isRecord(item)) {
      const nestedLines = renderObjectLines(item, indentLevel + 2, false)
      if (nestedLines.length === 1) {
        const inlineObject = nestedLines[0]?.trimStart() ?? "{}"
        lines.push(`${propertyIndent}${JSON.stringify(key)}: ${inlineObject},`)
        continue
      }

      lines.push(
        `${propertyIndent}${JSON.stringify(key)}: ${nestedLines[0]?.trimStart() ?? "{"}`,
      )
      lines.push(...nestedLines.slice(1, -1))
      lines.push(`${nestedLines[nestedLines.length - 1]},`)
      continue
    }

    lines.push(
      `${propertyIndent}${JSON.stringify(key)}: ${renderInlineValue(item)},`,
    )
  }

  lines.push(`${indent}}`)
  return lines
}

function renderBunLock(lock: BunLockFile): string {
  const rootObject = lock as unknown as Record<string, unknown>
  return `${renderObjectLines(rootObject, 0, true).join("\n")}\n`
}

export function dedupeLockText(lockText: string): DedupeLockResult {
  const parsedLock = parseBunLock(lockText)
  const duplicateGroups = analyzeDuplicatePackages(parsedLock)
  const rewrites = collectVersionRewrites(duplicateGroups)

  if (rewrites.size === 0) {
    return {
      changed: false,
      lockText,
      touchedEntries: 0,
      rewrittenPackages: 0,
    }
  }

  const packages = parsedLock.packages ?? {}
  const rewriteResult = rewriteEntries(packages, rewrites)
  if (rewriteResult.touchedEntries === 0) {
    return {
      changed: false,
      lockText,
      touchedEntries: 0,
      rewrittenPackages: 0,
    }
  }

  return {
    changed: true,
    lockText: renderBunLock(parsedLock),
    touchedEntries: rewriteResult.touchedEntries,
    rewrittenPackages: rewriteResult.rewrittenPackages,
  }
}
