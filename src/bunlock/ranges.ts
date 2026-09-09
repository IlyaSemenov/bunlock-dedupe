import semver from "semver"

import {
  type BunLockFile,
  type BunPackageMeta,
  isOptionalPeerDependency,
} from "./parse"

/** Return undefined when a range or version has no supported semver interpretation. */
export function evaluateRangeCompatibility(
  range: string,
  targetVersion: string,
): boolean | undefined {
  if (!semver.valid(targetVersion)) {
    return undefined
  }

  const normalized = range.trim()
  if (!normalized) {
    return undefined
  }

  if (
    normalized.startsWith("workspace:") ||
    normalized.startsWith("catalog:") ||
    normalized.startsWith("link:") ||
    normalized.startsWith("file:")
  ) {
    return undefined
  }

  if (semver.valid(normalized)) {
    return semver.eq(targetVersion, normalized)
  }

  const validRange = semver.validRange(normalized)
  if (!validRange) {
    return undefined
  }

  return semver.satisfies(targetVersion, validRange)
}

/**
 * Read the exact bare-name override Bun stores for a dependency.
 *
 * Bun 1.3.14 ignores selector keys and omits unsupported nested/path forms,
 * so matching those here would diverge from the package manager.
 */
export function dependencyOverrideRange(
  lock: Pick<BunLockFile, "overrides">,
  dependencyName: string,
): string | undefined {
  const overrides = lock.overrides
  if (!overrides) return undefined
  if (!Object.hasOwn(overrides, dependencyName)) return undefined
  return overrides[dependencyName]
}

/**
 * Return the range Bun actually enforces for a dependency request.
 *
 * An override remains authoritative even when it is not valid semver;
 * compatibility then stays unknown instead of falling back to the declaration.
 */
export function effectiveDependencyRange(
  lock: Pick<BunLockFile, "overrides">,
  dependencyName: string,
  declaredRange: string,
): string {
  const overrideRange = dependencyOverrideRange(lock, dependencyName)
  return overrideRange === undefined ? declaredRange : overrideRange
}

/**
 * Decide whether a resolved dependency should form a reachability edge.
 *
 * Only a known-incompatible optional peer is absent; required dependencies and
 * peers with unknown compatibility stay reachable.
 */
export function isResolvedDependencyReachable(
  lock: Pick<BunLockFile, "overrides">,
  requester: Pick<
    BunPackageMeta,
    | "dependencies"
    | "optionalDependencies"
    | "peerDependencies"
    | "optionalPeers"
  >,
  dependencyName: string,
  resolvedVersion: string,
): boolean {
  if (!isOptionalPeerDependency(requester, dependencyName)) return true

  const range = requester.peerDependencies?.[dependencyName]
  if (!range) return true

  return (
    evaluateRangeCompatibility(
      effectiveDependencyRange(lock, dependencyName, range),
      resolvedVersion,
    ) !== false
  )
}
