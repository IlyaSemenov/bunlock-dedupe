/**
 * Tell nested dependency keys apart from root scoped package keys.
 *
 * For an unscoped dependency, `@scope/name` can match the `/name` suffix even
 * though it is a root package key. A real nested key has another path segment,
 * such as `@scope/requester/name`.
 */
export function isNestedDependencyLockKey(
  lockKey: string,
  dependencyName: string,
): boolean {
  if (!lockKey.endsWith(`/${dependencyName}`)) return false

  return dependencyName.startsWith("@") || !/^@[^/]+\/[^/]+$/.test(lockKey)
}

/**
 * Resolve a dependency the way Bun lock keys are structured:
 * nearest nested `requester/dependency` wins, then the closest
 * ancestor-provided nested entry, then root `dependency`.
 *
 * This is the canonical lock-key resolution shared by graph building, update
 * planning, and update safety checks; only the lock keys matter, so any map
 * keyed by lock key works.
 *
 * @param requesterLockKey Package lock key that owns the dependency. Use
 * `undefined` for workspace/root resolution.
 * @param dependencyName Real npm package name being resolved.
 */
export function resolveDependencyLockKey(
  requesterLockKey: string | undefined,
  dependencyName: string,
  packagesByLockKey: ReadonlyMap<string, unknown>,
): string | undefined {
  if (requesterLockKey) {
    const nestedKey = `${requesterLockKey}/${dependencyName}`
    if (packagesByLockKey.has(nestedKey)) {
      return nestedKey
    }

    let bestCandidate: string | undefined
    let bestPrefixLength = -1
    for (const key of packagesByLockKey.keys()) {
      if (!isNestedDependencyLockKey(key, dependencyName)) {
        continue
      }

      const prefix = key.slice(0, -(dependencyName.length + 1))
      if (
        requesterLockKey === prefix ||
        requesterLockKey.startsWith(`${prefix}/`)
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
  }

  if (packagesByLockKey.has(dependencyName)) {
    return dependencyName
  }

  if (!requesterLockKey) {
    let uniqueCandidate: string | undefined
    for (const key of packagesByLockKey.keys()) {
      if (!isNestedDependencyLockKey(key, dependencyName)) {
        continue
      }

      if (uniqueCandidate) {
        return undefined
      }

      uniqueCandidate = key
    }

    return uniqueCandidate
  }

  return undefined
}
