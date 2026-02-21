export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function splitLockKeyPackages(lockKey: string): string[] {
  const parts = lockKey.split("/")
  const packages: string[] = []

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (!part) {
      continue
    }

    if (part.startsWith("@") && index + 1 < parts.length) {
      packages.push(`${part}/${parts[index + 1]}`)
      index += 1
      continue
    }

    packages.push(part)
  }

  return packages
}

export function getLockKeyNestingDepth(lockKey: string): number {
  return Math.max(0, splitLockKeyPackages(lockKey).length - 1)
}

export function compareLockKeysByNesting(left: string, right: string): number {
  const leftPackages = splitLockKeyPackages(left)
  const rightPackages = splitLockKeyPackages(right)
  const nestingCompare = leftPackages.length - rightPackages.length
  if (nestingCompare !== 0) {
    return nestingCompare
  }

  for (let index = 0; index < leftPackages.length; index += 1) {
    const compare = compareStrings(
      leftPackages[index] ?? "",
      rightPackages[index] ?? "",
    )
    if (compare !== 0) {
      return compare
    }
  }

  return 0
}
