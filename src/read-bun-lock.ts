import { readFileSync, statSync } from "node:fs"
import path from "node:path"

export type BunLockReadResult = {
  path: string
  content: string
}

const defaultLockFilename = "bun.lock"

function resolveBunLockPath(bunLockPath?: string): string {
  const p = bunLockPath ?? defaultLockFilename
  try {
    if (statSync(p).isDirectory()) {
      return path.join(p, defaultLockFilename)
    }
  } catch {
    // Not a directory or doesn't exist yet; let the caller surface the error.
  }
  return p
}

export function readBunLock(bunLockPath?: string): BunLockReadResult {
  const lockPath = resolveBunLockPath(bunLockPath)
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
