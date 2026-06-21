import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"

// Mock state, mutated by individual tests via `statFile()`/`statDir()`.
// Any path not registered here is treated as nonexistent.
const statResults = new Map<string, { isFile: boolean; isDirectory: boolean }>()

const statSpy = spyOn(fs, "statSync").mockImplementation(((p: string) => {
  const override = statResults.get(p)
  if (override) {
    return {
      isFile: () => override.isFile,
      isDirectory: () => override.isDirectory,
    }
  }
  throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
}) as typeof fs.statSync)

const cwdSpy = spyOn(process, "cwd")

const { resolveBunLockPath } = await import("./read-bun-lock")

afterAll(() => {
  statSpy.mockRestore()
  cwdSpy.mockRestore()
})

beforeEach(() => {
  statResults.clear()
  cwdSpy.mockReturnValue("/proj")
})

function statFile(p: string): void {
  statResults.set(p, { isFile: true, isDirectory: false })
}

function statDir(p: string): void {
  statResults.set(p, { isFile: false, isDirectory: true })
}

describe("resolveBunLockPath — walk-up", () => {
  test("returns bun.lock in cwd when present", () => {
    statFile("/proj/bun.lock")
    expect(resolveBunLockPath()).toBe("/proj/bun.lock")
  })

  test("walks up one level when missing in cwd", () => {
    cwdSpy.mockReturnValue("/proj/packages/foo")
    statFile("/proj/bun.lock")
    expect(resolveBunLockPath()).toBe("/proj/bun.lock")
  })

  test("walks up multiple levels", () => {
    cwdSpy.mockReturnValue("/proj/a/b/c")
    statFile("/proj/bun.lock")
    expect(resolveBunLockPath()).toBe("/proj/bun.lock")
  })

  test("returns the nearest match when several exist along the chain", () => {
    cwdSpy.mockReturnValue("/proj/a/b")
    statFile("/proj/a/bun.lock")
    statFile("/proj/bun.lock")
    expect(resolveBunLockPath()).toBe("/proj/a/bun.lock")
  })

  test("finds a lockfile at the filesystem root", () => {
    cwdSpy.mockReturnValue("/proj/sub")
    statFile("/bun.lock")
    expect(resolveBunLockPath()).toBe("/bun.lock")
  })

  test("throws when no lockfile exists anywhere up to root", () => {
    cwdSpy.mockReturnValue("/proj/sub")
    expect(() => resolveBunLockPath()).toThrow(
      /cannot find bun\.lock in \/proj\/sub or any parent directory/,
    )
  })

  test("skips entries that exist but are not files (directories)", () => {
    cwdSpy.mockReturnValue("/proj/parent/child")
    statDir("/proj/parent/child/bun.lock")
    statFile("/proj/parent/bun.lock")
    expect(resolveBunLockPath()).toBe("/proj/parent/bun.lock")
  })
})

describe("resolveBunLockPath — explicit path", () => {
  test("returns the given path as-is when it points to a file", () => {
    statFile("/custom/lock.json")
    expect(resolveBunLockPath("/custom/lock.json")).toBe("/custom/lock.json")
  })

  test("joins bun.lock when the given path is a directory", () => {
    statDir("/some/dir")
    expect(resolveBunLockPath("/some/dir")).toBe("/some/dir/bun.lock")
  })

  test("returns the given path as-is when statSync throws", () => {
    expect(resolveBunLockPath("/missing/bun.lock")).toBe("/missing/bun.lock")
  })
})
