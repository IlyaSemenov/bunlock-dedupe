import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { buildUpdateSummary, formatUpdateSummary } from "../src/cli-messages"
import {
  analyzeDuplicatePackages,
  dedupeLockText,
  formatDuplicatesReport,
  parseBunLock,
} from "../src/dedupe"
import { analyzeDuplicatePackagesWithUpdates } from "../src/dedupe/update-analyze"
import type { PackageMetadata } from "../src/registry"

const fixturesRoot = path.join(process.cwd(), "test", "fixtures")

type RegistryFixture = {
  versions: Record<string, string[]>
  metadata: Record<string, Record<string, PackageMetadata>>
}

function makeFixtureFetch(fixtureDir: string) {
  const registryPath = path.join(fixtureDir, "registry.json")
  const registry: RegistryFixture = JSON.parse(
    readFileSync(registryPath, "utf8"),
  )

  return async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString()

    if (!url.startsWith("https://registry.npmjs.org/")) {
      return new Response(null, { status: 404 })
    }

    const requestPath = url.slice("https://registry.npmjs.org/".length)
    const decoded = decodeURIComponent(requestPath)

    const slashIdx = decoded.startsWith("@")
      ? decoded.indexOf("/", decoded.indexOf("/") + 1)
      : decoded.indexOf("/")

    if (slashIdx === -1) {
      const pkgName = decoded
      const versions = registry.versions[pkgName]
      if (!versions) return new Response(null, { status: 404 })
      const versionsObj: Record<string, unknown> = {}
      for (const v of versions) versionsObj[v] = {}
      return new Response(JSON.stringify({ versions: versionsObj }), {
        status: 200,
      })
    }

    const pkgName = decoded.slice(0, slashIdx)
    const version = decoded.slice(slashIdx + 1)
    const meta = registry.metadata[pkgName]?.[version]
    if (!meta) return new Response(null, { status: 404 })
    return new Response(JSON.stringify(meta), { status: 200 })
  }
}

const allFixtures = readdirSync(fixturesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const dir = path.join(fixturesRoot, entry.name)
    const files = readdirSync(dir)
    return { name: entry.name, dir, files }
  })
  .filter((f) => f.files.includes("bun.lock"))
  .sort((a, b) => a.name.localeCompare(b.name))

for (const { name, dir, files } of allFixtures) {
  const hasDedupe =
    files.includes("report.all.txt") &&
    files.includes("report.fixable.txt") &&
    files.includes("bun.dedupe.lock")
  const hasUpdate =
    files.includes("registry.json") && files.includes("report.update.txt")

  test(`fixture: ${name}`, async () => {
    const lockText = readFileSync(path.join(dir, "bun.lock"), "utf8")

    if (hasDedupe) {
      const parsedLock = parseBunLock(lockText)
      const duplicateGroups = analyzeDuplicatePackages(parsedLock)

      const expectedAll = readFileSync(
        path.join(dir, "report.all.txt"),
        "utf8",
      ).trimEnd()
      const expectedFixable = readFileSync(
        path.join(dir, "report.fixable.txt"),
        "utf8",
      ).trimEnd()
      const expectedDedupe = readFileSync(
        path.join(dir, "bun.dedupe.lock"),
        "utf8",
      )

      expect(formatDuplicatesReport(duplicateGroups)).toBe(expectedAll)
      expect(
        formatDuplicatesReport(duplicateGroups, { fixableOnly: true }),
      ).toBe(expectedFixable)

      const dedupeResult = dedupeLockText(lockText)
      expect(dedupeResult.lockText).toBe(expectedDedupe)
    }

    if (hasUpdate) {
      const parsedLock = parseBunLock(lockText)
      const fetchFn = makeFixtureFetch(dir)
      const { duplicates, suggestedUpdates } =
        await analyzeDuplicatePackagesWithUpdates(parsedLock, { fetchFn })

      const fullOutput = [
        formatDuplicatesReport(duplicates, { suggestedUpdates }),
        "",
        formatUpdateSummary(
          buildUpdateSummary(duplicates, suggestedUpdates),
          "bun.lock",
        ),
      ].join("\n")

      const expected = readFileSync(
        path.join(dir, "report.update.txt"),
        "utf8",
      ).trimEnd()
      expect(fullOutput).toBe(expected)
    }
  })
}
