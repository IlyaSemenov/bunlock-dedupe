#!/usr/bin/env node

import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import {
  buildAnalyzeSummary,
  buildFixSummary,
  formatAnalyzeSummary,
  formatFixSummary,
} from "./cli-messages"
import {
  analyzeDuplicatePackages,
  dedupeLockText,
  formatDuplicatesReport,
  parseBunLock,
} from "./dedupe"
import { readBunLock } from "./read-bun-lock"

const commandName = "bunlock-dedupe"

function printUsage(): void {
  console.log(`${commandName} [path] [--fixable | --fix]`)
  console.log("")
  console.log("Analyze duplicate bun.lock sub-dependencies.")
  console.log("Use --fixable to show only fixable packages and versions.")
  console.log("Use --fix to rewrite dedupe-compatible entries.")
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  printUsage()
  process.exit(1)
}

function run(): void {
  let values: { fix: boolean; fixable: boolean; help: boolean }
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

  const bunLockPath = positionals[0]

  const { path: lockPath, content: lockText } = readBunLock(bunLockPath)

  const parsedLock = parseBunLock(lockText)
  const duplicateGroups = analyzeDuplicatePackages(parsedLock)

  if (!values.fix) {
    const dedupeResult = dedupeLockText(lockText)
    console.log(
      formatDuplicatesReport(duplicateGroups, {
        fixableOnly: values.fixable,
      }),
    )
    console.log("")
    const summary = buildAnalyzeSummary(
      duplicateGroups,
      dedupeResult.rewrittenPackages,
      dedupeResult.touchedEntries,
    )
    console.log(formatAnalyzeSummary(summary, lockPath))
    return
  }

  const result = dedupeLockText(lockText)
  if (!result.changed) {
    const summary = buildFixSummary(duplicateGroups, 0, 0)
    console.log(formatFixSummary(summary, lockPath))
    return
  }

  writeFileSync(lockPath, result.lockText, "utf8")
  const summary = buildFixSummary(
    duplicateGroups,
    result.rewrittenPackages,
    result.touchedEntries,
  )
  console.log(formatFixSummary(summary, lockPath))
}

run()
