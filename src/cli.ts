#!/usr/bin/env node

import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import {
  buildFixSummary,
  formatFixSummary,
  formatReport,
  formatReportOutput,
  formatUpdateFixSummary,
} from "./cli-messages"
import {
  analyzeDuplicatePackages,
  analyzeDuplicatePackagesWithUpdates,
  classifyUpdateSafety,
  dedupeLockText,
  formatDuplicatesReport,
  parseBunLock,
  type SuggestedUpdate,
  updateAndDedupeLockText,
} from "./dedupe"
import { readBunLock } from "./read-bun-lock"

const commandName = "bunlock-dedupe"

function printUsage(): void {
  console.log(
    `${commandName} [path] [--fixable | --fix] [--update [--offline]]`,
  )
  console.log("")
  console.log("Analyze duplicate bun.lock sub-dependencies.")
  console.log("Use --fixable to show only fixable packages and versions.")
  console.log("Use --fix to rewrite dedupe-compatible entries.")
  console.log(
    "Use --update to find intermediate dep updates that unlock deduplication.",
  )
  console.log("Use --update --offline to analyze only the local bun cache.")
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  printUsage()
  process.exit(1)
}

function countUniqueSkippedDedupePackages(updates: SuggestedUpdate[]): number {
  return new Set(
    updates.flatMap((update) => update.deduplicates.map((d) => d.name)),
  ).size
}

function buildSkippedUpdateSummary(updates: SuggestedUpdate[]): {
  skippedUpdateCount: number
  skippedPackageCount: number
  skippedDedupePackageCount: number
} {
  return {
    skippedUpdateCount: updates.length,
    skippedPackageCount: new Set(updates.map((update) => update.packageName))
      .size,
    skippedDedupePackageCount: countUniqueSkippedDedupePackages(updates),
  }
}

async function run(): Promise<void> {
  let values: {
    fix: boolean
    fixable: boolean
    help: boolean
    update: boolean
    offline: boolean
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
        fixable: {
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
      },
    })
    values = parsed.values
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

  if (values.offline && !values.update) {
    fail("--offline is only valid with --update")
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
    const { duplicates, suggestedUpdates } =
      await analyzeDuplicatePackagesWithUpdates(parsedLock, {
        offline: values.offline,
      })

    if (values.fix) {
      const result = await updateAndDedupeLockText(lockText, {
        offline: values.offline,
      })
      if (result.changed) {
        writeFileSync(lockPath, result.lockText, "utf8")
      }

      console.log(
        formatReportOutput(
          formatDuplicatesReport(duplicates, {
            fixableOnly: values.fixable,
            suggestedUpdates,
            skippedUpdates: result.skippedUpdates,
          }),
          formatUpdateFixSummary(
            result.changed
              ? {
                  kind: "updated",
                  updatedEntries: result.updatedEntries,
                  updatedPackages: result.updatedPackages,
                  dedupedEntries: result.dedupedEntries,
                  dedupedPackages: result.dedupedPackages,
                  ...buildSkippedUpdateSummary(result.skippedUpdates),
                }
              : {
                  kind: "no-change",
                  ...buildSkippedUpdateSummary(result.skippedUpdates),
                },
            lockPath,
          ),
        ),
      )
      return
    }

    const dedupeResult = dedupeLockText(lockText)

    console.log(
      formatReport(duplicates, dedupeResult, lockPath, {
        fixableOnly: values.fixable,
        suggestedUpdates,
        skippedUpdates: (
          await classifyUpdateSafety(lockText, suggestedUpdates, {
            offline: values.offline,
          })
        ).skippedUpdates,
      }),
    )
    return
  }

  const duplicateGroups = analyzeDuplicatePackages(parsedLock)

  if (!values.fix) {
    const dedupeResult = dedupeLockText(lockText)
    console.log(
      formatReport(duplicateGroups, dedupeResult, lockPath, {
        fixableOnly: values.fixable,
      }),
    )
    return
  }

  const result = dedupeLockText(lockText)
  if (!result.changed) {
    const fixSummary = buildFixSummary(duplicateGroups, 0, 0)
    console.log(formatFixSummary(fixSummary, lockPath))
    return
  }

  writeFileSync(lockPath, result.lockText, "utf8")
  const fixSummary = buildFixSummary(
    duplicateGroups,
    result.rewrittenPackages,
    result.touchedEntries,
  )
  console.log(formatFixSummary(fixSummary, lockPath))
}

run()
