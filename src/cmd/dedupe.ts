import { writeFileSync } from "node:fs"

import { defineCommand } from "citty"

import { dedupeLockText } from "../dedupe"
import { readBunLock } from "./utils/read"

export const dedupeCommand = defineCommand({
  meta: {
    name: "dedupe",
    description: "Deduplicate bun.lock sub-dependencies",
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
    const { path: lockPath, content: lockText } = readBunLock({
      bunLockPath: context.args.bunlockPath,
    })
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
  },
})
