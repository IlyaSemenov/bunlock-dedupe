export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function getLockKeyNestingDepth(lockKey: string): number {
  const parts = lockKey.split("/")
  let packageCount = 0

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (!part) {
      continue
    }

    packageCount += 1

    // Scoped names consume two path segments, e.g. "@types/node".
    if (part.startsWith("@") && index + 1 < parts.length) {
      index += 1
    }
  }

  return Math.max(0, packageCount - 1)
}

export function compareLockKeysByNesting(left: string, right: string): number {
  const nestingCompare =
    getLockKeyNestingDepth(left) - getLockKeyNestingDepth(right)
  if (nestingCompare !== 0) {
    return nestingCompare
  }

  return compareStrings(left, right)
}
