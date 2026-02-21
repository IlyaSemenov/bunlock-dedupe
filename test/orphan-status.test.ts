import { expect, test } from "bun:test"

import {
  analyzeDuplicatePackages,
  formatDuplicatesReport,
  parseBunLock,
} from "../src/dedupe"

function formatUtilsOnly(lockText: string): string {
  const duplicates = analyzeDuplicatePackages(parseBunLock(lockText)).filter(
    (duplicate) => duplicate.name === "utils",
  )
  return formatDuplicatesReport(duplicates)
}

test("marks version as orphan when all incoming paths are removed by parent rewrites", () => {
  const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "example",
      "dependencies": {
        "app-a": "^1.0.0",
        "app-b": "^2.0.0",
        "app-c": "^3.0.0",
      },
    },
  },
  "packages": {
    "app-a": ["app-a@1.5.0", "", { "dependencies": { "utils": "^1.0.0" } }, "sha"],

    "app-b": ["app-b@2.0.0", "", { "dependencies": { "utils": "^2.0.0" } }, "sha"],

    "app-c": ["app-c@3.0.0", "", { "dependencies": { "app-a": "^1.0.0" } }, "sha"],

    "app-c/app-a": ["app-a@1.6.0", "", { "dependencies": { "utils": "^2.0.0" } }, "sha"],

    "utils": ["utils@2.1.0", "", {}, "sha"],

    "app-a/utils": ["utils@1.2.0", "", {}, "sha"],
  },
}`

  const output = formatUtilsOnly(lockText)
  expect(output).toBe(
    `utils
  ✅ 2.1.0
    - example > app-b: ^2.0.0
    - example > app-c > app-a: ^2.0.0
  🗑️ 1.2.0
    - example > app-a ⬆️: ^1.0.0`,
  )
})

test("keeps version as cannot-dedupe when it still has at least one non-rewritten path", () => {
  const lockText = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "example",
      "dependencies": {
        "app-a": "^1.0.0",
        "app-b": "^2.0.0",
        "app-c": "3.0.0",
      },
    },
  },
  "packages": {
    "app-a": ["app-a@1.5.0", "", { "dependencies": { "utils": "^1.0.0" } }, "sha"],

    "app-b": ["app-b@2.0.0", "", { "dependencies": { "utils": "^2.0.0" } }, "sha"],

    "app-c": ["app-c@3.0.0", "", { "dependencies": { "utils": "^1.0.0" } }, "sha"],

    "utils": ["utils@2.1.0", "", {}, "sha"],

    "app-a/utils": ["utils@1.2.0", "", {}, "sha"],

    "app-c/utils": ["utils@1.2.0", "", {}, "sha"],
  },
}`

  const output = formatUtilsOnly(lockText)
  expect(output).toBe(
    `utils
  ✅ 2.1.0
    - example > app-b: ^2.0.0
  ❌ 1.2.0
    - example > app-a: ^1.0.0
    - example > app-c: ^1.0.0`,
  )
})
