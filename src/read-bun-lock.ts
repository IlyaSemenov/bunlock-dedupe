import { readFileSync, statSync } from "node:fs"
import path from "node:path"

export type BunLockReadResult = {
  path: string
  content: string
}

const defaultLockFilename = "bun.lock"

export function resolveBunLockPath(bunLockPath?: string): string {
  if (bunLockPath) {
    try {
      if (statSync(bunLockPath).isDirectory()) {
        return path.join(bunLockPath, defaultLockFilename)
      }
    } catch {
      // Not a directory or doesn't exist yet; let the caller surface the error.
    }
    return bunLockPath
  }

  // No explicit path: walk up from cwd looking for bun.lock, bail at filesystem root.
  const startDir = process.cwd()
  let dir = startDir
  while (true) {
    const candidate = path.join(dir, defaultLockFilename)
    try {
      if (statSync(candidate).isFile()) {
        return candidate
      }
    } catch {
      // Not present here; keep walking up.
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new Error(
        `cannot find ${defaultLockFilename} in ${startDir} or any parent directory`,
      )
    }
    dir = parent
  }
}

export function readBunLock(bunLockPath?: string): BunLockReadResult {
  let lockPath: string
  try {
    lockPath = resolveBunLockPath(bunLockPath)
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : "cannot resolve bun.lock path"}`,
    )
    process.exit(1)
  }
  try {
    return {
      path: lockPath,
      content: readFileSync(lockPath, "utf8"),
    }
  } catch {
    console.error(`Error: cannot read bun.lock at ${lockPath}`)
    process.exit(1)
  }
}
