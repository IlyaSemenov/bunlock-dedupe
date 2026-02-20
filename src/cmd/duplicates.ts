import { defineCommand } from "citty"

import {
  analyzeDuplicatePackages,
  formatDuplicatesReport,
  parseBunLock,
} from "../dedupe"
import { readBunLock } from "./utils/read"

export const duplicatesCommand = defineCommand({
  meta: {
    name: "duplicates",
    description: "Inspect bun.lock and report duplicate dependency versions",
  },
  args: {
    bunlockPath: {
      type: "positional",
      required: false,
      valueHint: "path",
      description: "Path to bun.lock file or project directory",
    },
  },
  run: (context) => {
    const { content: lockText } = readBunLock({
      bunLockPath: context.args.bunlockPath,
    })
    const parsedLock = parseBunLock(lockText)
    const duplicateGroups = analyzeDuplicatePackages(parsedLock)
    console.log(formatDuplicatesReport(duplicateGroups))
  },
})
