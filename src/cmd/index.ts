import { defineCommand } from "citty"

import { dedupeCommand } from "./dedupe"
import { duplicatesCommand } from "./duplicates"

export const mainCommand = defineCommand({
  meta: {
    name: "bunlock",
    description: "Analyze and deduplicate bun.lock dependencies",
  },
  subCommands: {
    dedupe: dedupeCommand,
    duplicates: duplicatesCommand,
    dupes: duplicatesCommand,
  },
})
