#!/usr/bin/env node

import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import {
  buildFixSummary,
  formatFixSummary,
  formatReport,
  formatUpdateFixReport,
} from "./cli-messages"
import {
  analyzeDuplicatePackages,
  analyzeDuplicatePackagesWithUpdates,
  classifyUpdateSafety,
  dedupeLockText,
  parseBunLock,
  updateAndDedupeLockText,
} from "./dedupe"
import { createProgressRenderer } from "./progress"
import { readBunLock } from "./read-bun-lock"
import { createPackumentCache, RegistryError } from "./registry"
import { clearRegistryCache } from "./registry-cache"

const commandName = "bunlock-dedupe"

function printUsage(): void {
  console.log(
    `${commandName} [path] [--all] [--fix] [--update [--offline|--refresh]]`,
  )
  console.log(`${commandName} --clear-cache`)
  console.log("")
  console.log("Analyze duplicate bun.lock sub-dependencies.")
  console.log("Use --all to also show packages that cannot be deduped.")
  console.log("Use --fix to rewrite dedupe-compatible entries.")
  console.log(
    "Use --update to find intermediate dep updates that unlock deduplication.",
  )
  console.log("Use --update --offline to analyze only the local bun cache.")
  console.log("Use --update --refresh to revalidate cached registry data.")
  console.log("Use --clear-cache to remove all persistent registry data.")
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  printUsage()
  process.exit(1)
}

async function run(): Promise<void> {
  let values: {
    fix: boolean
    all: boolean
    help: boolean
    update: boolean
    offline: boolean
    refresh: boolean
    clearCache: boolean
  }
  let positionals: string[]

  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        fix: {
          type: "boolean",
          short: "f",
          default: false,
        },
        all: {
          type: "boolean",
          default: false,
        },
        help: {
          type: "boolean",
          short: "h",
          default: false,
        },
        update: {
          type: "boolean",
          default: false,
        },
        offline: {
          type: "boolean",
          default: false,
        },
        refresh: {
          type: "boolean",
          default: false,
        },
        "clear-cache": {
          type: "boolean",
          default: false,
        },
      },
    })
    const { "clear-cache": clearCache, ...parsedValues } = parsed.values
    values = { ...parsedValues, clearCache }
    positionals = parsed.positionals
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments"
    fail(message)
  }

  if (values.help) {
    printUsage()
    return
  }

  if (positionals.length > 1) {
    fail("expected at most one positional path argument")
  }

  if (values.clearCache) {
    if (
      positionals.length > 0 ||
      values.all ||
      values.fix ||
      values.update ||
      values.offline ||
      values.refresh
    ) {
      fail("--clear-cache cannot be combined with other modes or a path")
    }
    const cacheDir = await clearRegistryCache()
    console.log(`Cleared registry cache at ${cacheDir}.`)
    return
  }

  if (values.offline && !values.update) {
    fail("--offline is only valid with --update")
  }

  if (values.refresh && !values.update) {
    fail("--refresh is only valid with --update")
  }

  if (values.refresh && values.offline) {
    fail("--refresh cannot be used with --offline")
  }

  if (values.offline && values.fix) {
    fail(
      "--offline cannot be used with --fix because bun cache lacks registry integrity metadata",
    )
  }

  const bunLockPath = positionals[0]
  const { path: lockPath, content: lockText } = readBunLock(bunLockPath)
  const parsedLock = parseBunLock(lockText)

  if (values.update) {
    const cache = createPackumentCache()
    const progress = createProgressRenderer(process.stderr)

    const { duplicates, suggestedUpdates } =
      await analyzeDuplicatePackagesWithUpdates(parsedLock, {
        offline: values.offline,
        refresh: values.refresh,
        cache,
        onProgress: progress.update,
      })

    if (values.fix) {
      const result = await updateAndDedupeLockText(lockText, {
        offline: values.offline,
        refresh: values.refresh,
        cache,
        suggestedUpdates,
      })
      progress.end()
      if (result.changed) {
        writeFileSync(lockPath, result.lockText, "utf8")
      }

      console.log(
        formatUpdateFixReport(duplicates, result, lockPath, {
          includeUnfixable: values.all,
        }),
      )
      return
    }

    const dedupeResult = dedupeLockText(lockText)
    const { skippedUpdates } = await classifyUpdateSafety(
      lockText,
      suggestedUpdates,
      {
        offline: values.offline,
        refresh: values.refresh,
        cache,
      },
    )
    progress.end()

    console.log(
      formatReport(duplicates, dedupeResult, lockPath, {
        includeUnfixable: values.all,
        suggestedUpdates,
        skippedUpdates,
      }),
    )
    return
  }

  const duplicates = analyzeDuplicatePackages(parsedLock)

  if (!values.fix) {
    const dedupeResult = dedupeLockText(lockText)
    console.log(
      formatReport(duplicates, dedupeResult, lockPath, {
        includeUnfixable: values.all,
      }),
    )
    return
  }

  const result = dedupeLockText(lockText)
  if (!result.changed) {
    const fixSummary = buildFixSummary(duplicates, 0, 0)
    console.log(formatFixSummary(fixSummary, lockPath))
    return
  }

  writeFileSync(lockPath, result.lockText, "utf8")
  const fixSummary = buildFixSummary(
    duplicates,
    result.rewrittenPackages,
    result.touchedEntries,
  )
  console.log(formatFixSummary(fixSummary, lockPath))
}

run().catch((error: unknown) => {
  if (error instanceof RegistryError) {
    // A transient registry failure would otherwise produce a report skewed by
    // missing data, so abort instead of reporting partial results.
    console.error(`Error: ${error.message}`)
    process.exit(1)
  }
  throw error
})
