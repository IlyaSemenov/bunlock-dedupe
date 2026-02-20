import { readFileSync, statSync } from "node:fs"
import path from "node:path"

export type BunLockOptions = {
  bunLockPath?: string
}

export type BunLockReadResult = {
  path: string
  content: string
}

const defaultLockFilename = "bun.lock"

function resolveBunLockPath(options: BunLockOptions = {}): string {
  const p = options.bunLockPath ?? defaultLockFilename
  try {
    if (statSync(p).isDirectory()) {
      return path.join(p, defaultLockFilename)
    }
  } catch {
    // Not a directory or doesn't exist yet; let the caller surface the error.
  }
  return p
}

export function readBunLock(options: BunLockOptions = {}): BunLockReadResult {
  const lockPath = resolveBunLockPath(options)
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
