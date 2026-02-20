#!/usr/bin/env node

import { writeFileSync } from "node:fs"
import { parseArgs } from "node:util"

import {
  analyzeDuplicatePackages,
  dedupeLockText,
  formatDuplicatesReport,
  parseBunLock,
} from "./dedupe"
import { readBunLock } from "./read-bun-lock"

const commandName = "bunlock-dedupe"
const removedSubcommands = new Set(["dedupe", "duplicates", "dupes"])

function printUsage(): void {
  console.log(`${commandName} [path] [--fix]`)
  console.log("")
  console.log("Analyze duplicate bun.lock sub-dependencies by default.")
  console.log("Use --fix to rewrite dedupe-compatible entries.")
}

function fail(message: string): never {
  console.error(`Error: ${message}`)
  printUsage()
  process.exit(1)
}

function run(): void {
  let values: { fix: boolean; help: boolean }
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

  if (bunLockPath && removedSubcommands.has(bunLockPath)) {
    fail(`subcommands were removed; use ${commandName} [path] [--fix]`)
  }

  const { path: lockPath, content: lockText } = readBunLock(bunLockPath)

  if (!values.fix) {
    const parsedLock = parseBunLock(lockText)
    const duplicateGroups = analyzeDuplicatePackages(parsedLock)
    console.log(formatDuplicatesReport(duplicateGroups))
    return
  }

  const result = dedupeLockText(lockText)
  if (!result.changed) {
    console.log(`No dedupe opportunities found in ${lockPath}.`)
    return
  }

  writeFileSync(lockPath, result.lockText, "utf8")
  console.log(
    `Dedupe complete: rewrote ${result.touchedEntries} entr${
      result.touchedEntries === 1 ? "y" : "ies"
    } across ${result.rewrittenPackages} package${
      result.rewrittenPackages === 1 ? "" : "s"
    } in ${lockPath}.`,
  )
}

run()
