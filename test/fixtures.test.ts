import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import {
  analyzeDuplicatePackages,
  dedupeLockText,
  formatDuplicatesReport,
  parseBunLock,
} from "../src/dedupe"

const fixturesRoot = path.join(process.cwd(), "test", "fixtures")

const fixtureNames = readdirSync(fixturesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .filter((entry) => {
    const fixtureDir = path.join(fixturesRoot, entry.name)
    const files = readdirSync(fixtureDir)
    return (
      files.includes("bun.lock") &&
      files.includes("duplicates.txt") &&
      files.includes("duplicates.fixable.txt") &&
      files.includes("bun.lock.dedupe")
    )
  })
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right))

for (const fixtureName of fixtureNames) {
  test(`fixture: ${fixtureName}`, () => {
    const fixtureDir = path.join(fixturesRoot, fixtureName)
    const sourceLockPath = path.join(fixtureDir, "bun.lock")
    const expectedDuplicatesPath = path.join(fixtureDir, "duplicates.txt")
    const expectedFixableDuplicatesPath = path.join(
      fixtureDir,
      "duplicates.fixable.txt",
    )
    const expectedDedupePath = path.join(fixtureDir, "bun.lock.dedupe")

    const lockText = readFileSync(sourceLockPath, "utf8")
    const expectedDuplicatesOutput = readFileSync(
      expectedDuplicatesPath,
      "utf8",
    ).trimEnd()
    const expectedFixableDuplicatesOutput = readFileSync(
      expectedFixableDuplicatesPath,
      "utf8",
    ).trimEnd()
    const expectedDedupeOutput = readFileSync(expectedDedupePath, "utf8")

    const parsedLock = parseBunLock(lockText)
    const duplicateGroups = analyzeDuplicatePackages(parsedLock)
    const duplicatesOutput = formatDuplicatesReport(duplicateGroups)
    const fixableDuplicatesOutput = formatDuplicatesReport(duplicateGroups, {
      fixableOnly: true,
    })
    expect(duplicatesOutput).toBe(expectedDuplicatesOutput)
    expect(fixableDuplicatesOutput).toBe(expectedFixableDuplicatesOutput)

    const dedupeResult = dedupeLockText(lockText)
    expect(dedupeResult.lockText).toBe(expectedDedupeOutput)
  })
}
