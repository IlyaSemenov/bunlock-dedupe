import {
  analyzeDuplicatePackages,
  type DuplicatePackageInfo,
  isNestedDependencyLockKey,
} from "./analyze"
import {
  type BunLockFile,
  type BunPackageEntry,
  isPackageEntry,
  normalizeDependencyMap,
  packageEntryMeta,
  parseBunLock,
  parseResolvedSpec,
} from "./parse"

type RewriteByPackage = Map<string, Map<string, string>>
type PackageTemplate = { lockKey: string; entry: BunPackageEntry }
type TemplatesByPackage = Map<string, Map<string, PackageTemplate>>

/** Summary returned by the text-level lockfile rewrite API. */
export type DedupeLockResult = {
  /** True when returned `lockText` should replace the input. */
  changed: boolean
  lockText: string
  /** Number of package entries rewritten or removed across all passes. */
  touchedEntries: number
  /** Number of distinct package names affected by the rewrite. */
  rewrittenPackages: number
}

/** Convert analyzer rows into the package/version rewrite table used by fix. */
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

/**
 * Index package entries by package name and resolved version.
 *
 * Root entries win over nested entries for the same version because replacing a
 * nested entry with the root tuple usually matches Bun's preferred lock shape.
 */
function collectPackageIndex(packages: Record<string, BunPackageEntry>): {
  templates: TemplatesByPackage
  rootVersions: Map<string, string>
} {
  const templates: TemplatesByPackage = new Map()
  const rootVersions = new Map<string, string>()

  for (const [lockKey, entry] of Object.entries(packages)) {
    if (!isPackageEntry(entry)) {
      continue
    }

    const [spec] = entry
    const parsed = parseResolvedSpec(spec)
    if (!parsed) {
      continue
    }

    let byVersion = templates.get(parsed.name)
    if (!byVersion) {
      byVersion = new Map()
      templates.set(parsed.name, byVersion)
    }
    if (!byVersion.has(parsed.version) || lockKey === parsed.name) {
      byVersion.set(parsed.version, { lockKey, entry })
    }

    if (lockKey === parsed.name) {
      rootVersions.set(parsed.name, parsed.version)
    }
  }

  return { templates, rootVersions }
}

/**
 * Resolve the package entry that a dependency would fall back to if a nested
 * entry were removed.
 *
 * This mirrors the lock-key lookup used by the analyzer: closest ancestor
 * nested entry first, then root entry.
 *
 * @param requesterLockKey Lock key whose dependency is being resolved, or
 * `undefined` for workspace/root lookup.
 * @param dependencyName Real npm package name to resolve.
 * @param excludedKey Candidate key to ignore, usually the entry being tested
 * for removal.
 */
function resolveFallbackLockKey(
  packages: Record<string, BunPackageEntry>,
  requesterLockKey: string | undefined,
  dependencyName: string,
  excludedKey: string,
): string | undefined {
  let bestCandidate: string | undefined
  let bestPrefixLength = -1
  for (const key of Object.keys(packages)) {
    if (
      key === excludedKey ||
      !isNestedDependencyLockKey(key, dependencyName)
    ) {
      continue
    }

    const prefix = key.slice(0, -(dependencyName.length + 1))
    if (
      requesterLockKey === prefix ||
      requesterLockKey?.startsWith(`${prefix}/`)
    ) {
      if (prefix.length > bestPrefixLength) {
        bestCandidate = key
        bestPrefixLength = prefix.length
      }
    }
  }
  if (bestCandidate) {
    return bestCandidate
  }

  return Object.hasOwn(packages, dependencyName) ? dependencyName : undefined
}

function entryDependencyNames(entry: BunPackageEntry): string[] {
  const meta = packageEntryMeta(entry)
  if (!meta) return []

  return Object.keys({
    ...meta.dependencies,
    ...meta.optionalDependencies,
    ...meta.peerDependencies,
  })
}

function resolvesSameDependencies(
  packages: Record<string, BunPackageEntry>,
  entry: BunPackageEntry,
  nestedKey: string,
  fallbackKey: string,
): boolean {
  return entryDependencyNames(entry).every(
    (depName) =>
      resolveFallbackLockKey(packages, nestedKey, depName, "") ===
      resolveFallbackLockKey(packages, fallbackKey, depName, ""),
  )
}

function clonePackageEntry(
  entry: BunPackageEntry,
  options?: { stripBundled?: boolean },
): BunPackageEntry {
  const [spec, resolved, meta, integrity] = entry
  const clonedMeta = meta !== undefined ? { ...meta } : undefined
  if (options?.stripBundled && clonedMeta?.bundled === true) {
    delete clonedMeta.bundled
  }

  return [spec, resolved, clonedMeta, integrity] as BunPackageEntry
}

/**
 * Remove nested entries that became redundant after rewrites: when a nested
 * entry resolves to exactly the same package entry that its requester would
 * get anyway (e.g. the root entry was rewritten up to the nested version),
 * `bun install` prunes it — so should we. Only safe when both contexts also
 * resolve every dependency of the entry to the same lock key.
 */
function pruneRedundantNestedEntries(
  packages: Record<string, BunPackageEntry>,
): { prunedEntries: number; prunedPackageNames: Set<string> } {
  let prunedEntries = 0
  const prunedPackageNames = new Set<string>()
  let changed = true

  while (changed) {
    changed = false

    for (const lockKey of Object.keys(packages)) {
      const entry = packages[lockKey]
      if (!isPackageEntry(entry)) continue

      const [spec] = entry
      const parsed = parseResolvedSpec(spec)
      if (!parsed || lockKey === parsed.name) continue
      if (!lockKey.endsWith(`/${parsed.name}`)) continue

      const childPrefix = `${lockKey}/`
      if (Object.keys(packages).some((key) => key.startsWith(childPrefix))) {
        continue
      }

      const requesterLockKey = lockKey.slice(0, -(parsed.name.length + 1))
      const fallbackKey = resolveFallbackLockKey(
        packages,
        requesterLockKey,
        parsed.name,
        lockKey,
      )
      if (!fallbackKey) continue

      const fallbackEntry = packages[fallbackKey]
      if (!isPackageEntry(fallbackEntry)) continue
      if (JSON.stringify(fallbackEntry) !== JSON.stringify(entry)) continue
      if (!resolvesSameDependencies(packages, entry, lockKey, fallbackKey)) {
        continue
      }

      delete packages[lockKey]
      prunedEntries += 1
      prunedPackageNames.add(parsed.name)
      changed = true
    }
  }

  return { prunedEntries, prunedPackageNames }
}

function collectWorkspacePackageKeys(lock: BunLockFile): Set<string> {
  const keys = new Set<string>()

  for (const workspace of Object.values(lock.workspaces ?? {})) {
    const workspaceName = workspace.name?.trim()
    if (workspaceName) keys.add(workspaceName)
  }

  return keys
}

/**
 * Remove entries that cannot be reached from any workspace dependency after a
 * rewrite.
 *
 * Workspace package entries themselves are preserved even when no package entry
 * points at them, because Bun lockfiles may include local workspaces as package
 * keys.
 */
function pruneUnreachableEntries(
  lock: BunLockFile,
  packages: Record<string, BunPackageEntry>,
): { prunedEntries: number; prunedPackageNames: Set<string> } {
  const reachable = new Set<string>()
  const queue: string[] = []
  const workspacePackageKeys = collectWorkspacePackageKeys(lock)

  const enqueue = (lockKey: string | undefined): void => {
    if (!lockKey || reachable.has(lockKey)) return

    reachable.add(lockKey)
    queue.push(lockKey)
  }

  for (const workspace of Object.values(lock.workspaces ?? {})) {
    const workspaceName = workspace.name?.trim()
    const workspaceDeps = {
      ...normalizeDependencyMap(workspace.dependencies),
      ...normalizeDependencyMap(workspace.devDependencies),
      ...normalizeDependencyMap(workspace.optionalDependencies),
      ...normalizeDependencyMap(workspace.peerDependencies),
    }

    for (const dependencyName of Object.keys(workspaceDeps)) {
      enqueue(
        resolveFallbackLockKey(
          packages,
          workspaceName || undefined,
          dependencyName,
          "",
        ),
      )
      enqueue(resolveFallbackLockKey(packages, undefined, dependencyName, ""))
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const lockKey = queue[index]
    if (!lockKey) continue

    const entry = packages[lockKey]
    if (!isPackageEntry(entry)) continue

    for (const dependencyName of entryDependencyNames(entry)) {
      enqueue(resolveFallbackLockKey(packages, lockKey, dependencyName, ""))
    }
  }

  let prunedEntries = 0
  const prunedPackageNames = new Set<string>()

  for (const [lockKey, entry] of Object.entries(packages)) {
    if (reachable.has(lockKey) || workspacePackageKeys.has(lockKey)) continue

    if (isPackageEntry(entry)) {
      const parsed = parseResolvedSpec(entry[0])
      if (parsed) prunedPackageNames.add(parsed.name)
    }

    delete packages[lockKey]
    prunedEntries += 1
  }

  return { prunedEntries, prunedPackageNames }
}

/**
 * Apply one rewrite pass.
 *
 * A pass may unlock new rewrites by deleting or replacing requester entries, so
 * `dedupeLockText` runs this repeatedly until no more entries change.
 */
function rewriteEntries(
  lock: BunLockFile,
  packages: Record<string, BunPackageEntry>,
  rewrites: RewriteByPackage,
): { touchedEntries: number; touchedPackageNames: Set<string> } {
  const { templates, rootVersions } = collectPackageIndex(packages)
  const touchedPackageNames = new Set<string>()
  let touchedEntries = 0

  for (const lockKey of Object.keys(packages)) {
    const entry = packages[lockKey]
    if (!isPackageEntry(entry)) {
      continue
    }

    const [entrySpec] = entry
    const parsed = parseResolvedSpec(entrySpec)
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

    // `bundled` belongs to the original bundled subtree. When a bundled tuple
    // is reused elsewhere as a dedupe template, Bun drops that marker.
    packages[lockKey] = clonePackageEntry(replacement.entry, {
      stripBundled: replacement.lockKey !== lockKey,
    })
    touchedEntries += 1
    touchedPackageNames.add(parsed.name)
  }

  if (touchedEntries > 0) {
    const pruneResult = pruneRedundantNestedEntries(packages)
    touchedEntries += pruneResult.prunedEntries
    for (const name of pruneResult.prunedPackageNames) {
      touchedPackageNames.add(name)
    }

    const unreachablePruneResult = pruneUnreachableEntries(lock, packages)
    touchedEntries += unreachablePruneResult.prunedEntries
    for (const name of unreachablePruneResult.prunedPackageNames) {
      touchedPackageNames.add(name)
    }
  }

  return {
    touchedEntries,
    touchedPackageNames,
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
  const packageEntries = Object.entries(value).filter(
    ([, packageEntry]) => packageEntry !== undefined,
  )

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

export function renderBunLock(lock: BunLockFile): string {
  const rootObject = lock as unknown as Record<string, unknown>
  return `${renderObjectLines(rootObject, 0, true).join("\n")}\n`
}

/**
 * Parse, rewrite, prune, and render a bun.lock string.
 *
 * The fixed-point loop is intentional: one dedupe can make another nested
 * entry redundant or reachable through a newer target only after the first pass
 * has changed the graph.
 *
 * @param lockText Raw `bun.lock` text, not a parsed object, so the full
 * parse/rewrite/render path is exercised.
 */
export function dedupeLockText(lockText: string): DedupeLockResult {
  const parsedLock = parseBunLock(lockText)
  const packages = parsedLock.packages ?? {}
  parsedLock.packages = packages

  let touchedEntries = 0
  const touchedPackageNames = new Set<string>()

  for (let pass = 0; pass < 50; pass += 1) {
    const duplicateGroups = analyzeDuplicatePackages(parsedLock)
    const rewrites = collectVersionRewrites(duplicateGroups)
    const rewriteResult = rewriteEntries(parsedLock, packages, rewrites)
    if (rewriteResult.touchedEntries === 0) break

    touchedEntries += rewriteResult.touchedEntries
    for (const name of rewriteResult.touchedPackageNames) {
      touchedPackageNames.add(name)
    }
  }

  if (touchedEntries === 0) {
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
    touchedEntries,
    rewrittenPackages: touchedPackageNames.size,
  }
}
