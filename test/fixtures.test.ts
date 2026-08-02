import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { formatReport } from "../src/cli-messages"
import {
  analyzeDuplicatePackages,
  classifyUpdateSafety,
  dedupeLockText,
  parseBunLock,
  updateAndDedupeLockText,
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

    if (slashIdx !== -1) {
      // Packument requests must hit the package root, not a per-version URL.
      return new Response(null, { status: 404 })
    }

    const pkgName = decoded
    const versions = registry.versions[pkgName]
    if (!versions) return new Response(null, { status: 404 })

    const versionsObj: Record<string, PackageMetadata> = {}
    for (const version of versions) {
      versionsObj[version] = registry.metadata[pkgName]?.[version] ?? {
        version,
      }
    }
    return new Response(JSON.stringify({ versions: versionsObj }), {
      status: 200,
    })
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
  const hasUpdateFix = hasUpdate && files.includes("bun.update.lock")

  test(`fixture: ${name}`, async () => {
    const lockText = readFileSync(path.join(dir, "bun.lock"), "utf8")

    if (hasDedupe) {
      const parsedLock = parseBunLock(lockText)
      const duplicates = analyzeDuplicatePackages(parsedLock)
      const dedupeResult = dedupeLockText(lockText)

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

      expect(
        formatReport(duplicates, dedupeResult, "bun.lock", {
          includeUnfixable: true,
        }),
      ).toBe(expectedAll)
      expect(
        formatReport(duplicates, dedupeResult, "bun.lock", {
          includeUnfixable: false,
        }),
      ).toBe(expectedFixable)

      expect(dedupeResult.lockText).toBe(expectedDedupe)
    }

    if (hasUpdate) {
      const parsedLock = parseBunLock(lockText)
      const dedupeResult = dedupeLockText(lockText)
      const fetchFn = makeFixtureFetch(dir)
      const { duplicates, suggestedUpdates } =
        await analyzeDuplicatePackagesWithUpdates(parsedLock, { fetchFn })
      const { skippedUpdates } = await classifyUpdateSafety(
        lockText,
        suggestedUpdates,
        { fetchFn },
      )

      const fullOutput = formatReport(duplicates, dedupeResult, "bun.lock", {
        suggestedUpdates,
        skippedUpdates,
      })

      const expected = readFileSync(
        path.join(dir, "report.update.txt"),
        "utf8",
      ).trimEnd()
      expect(fullOutput).toBe(expected)

      if (hasUpdateFix) {
        const updateResult = await updateAndDedupeLockText(lockText, {
          fetchFn,
          suggestedUpdates,
        })
        expect(updateResult.lockText).toBe(
          readFileSync(path.join(dir, "bun.update.lock"), "utf8"),
        )
      }
    }
  })
}
