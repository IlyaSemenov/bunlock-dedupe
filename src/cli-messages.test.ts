import { describe, expect, test } from "bun:test"

import {
  buildFixSummary,
  countCannotDedupePackages,
  formatFixSummary,
  formatReportSummary,
  formatUpdateFixReport,
  formatUpdateFixSummary,
  type ReportSummary,
} from "./cli-messages"
import type { DuplicatePackageInfo, SuggestedUpdate } from "./dedupe"
import { analyzeDuplicatePackages, parseBunLock } from "./dedupe"

const lockPath = "/project/bun.lock"

function makeGroups(count: number): DuplicatePackageInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `pkg-${i}`,
    targetVersion: "1.0.0",
    versions: [],
  }))
}

// --- formatReportSummary ---

describe("formatReportSummary", () => {
  test("clean", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 0,
      readyPackages: 0,
      intermediatePackages: 0,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 0,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "All clean — no duplicate packages in /project/bun.lock.",
    )
  })

  test("ready only — all fixable", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 3,
      readyPackages: 3,
      intermediatePackages: 0,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 0,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "3 duplicate packages in /project/bun.lock.\n" +
        "3 packages can be deduped.\n" +
        "\n" +
        "Run with --fix to apply available dedupes.",
    )
  })

  test("ready only — singular", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 1,
      readyPackages: 1,
      intermediatePackages: 0,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 0,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "1 duplicate package in /project/bun.lock.\n" +
        "1 package can be deduped.\n" +
        "\n" +
        "Run with --fix to apply available dedupes.",
    )
  })

  test("ready + cannot", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 5,
      readyPackages: 3,
      intermediatePackages: 0,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 2,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "5 duplicate packages in /project/bun.lock.\n" +
        "3 packages can be deduped.\n" +
        "2 packages cannot be deduped.\n" +
        "\n" +
        "Run with --fix to apply available dedupes.",
    )
  })

  test("cannot only — nothing can be done", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 3,
      readyPackages: 0,
      intermediatePackages: 0,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 3,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "3 duplicate packages in /project/bun.lock.\n" +
        "3 packages cannot be deduped.",
    )
  })

  test("cannot only — singular", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 1,
      readyPackages: 0,
      intermediatePackages: 0,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 1,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "1 duplicate package in /project/bun.lock.\n" +
        "1 package cannot be deduped.",
    )
  })

  test("prune-only cleanup", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 2,
      readyPackages: 0,
      cleanupEntries: 2,
      intermediatePackages: 0,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 2,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "2 duplicate packages in /project/bun.lock.\n" +
        "2 packages cannot be deduped.\n" +
        "2 unreachable entries can be removed.\n" +
        "\n" +
        "Run with --fix to remove unreachable entries.",
    )
  })

  test("mixed dedupe and cleanup", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 1,
      readyPackages: 1,
      cleanupEntries: 2,
      intermediatePackages: 0,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 0,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "1 duplicate package in /project/bun.lock.\n" +
        "1 package can be deduped.\n" +
        "2 unreachable entries can be removed.\n" +
        "\n" +
        "Run with --fix to apply available dedupes and remove unreachable entries.",
    )
  })

  test("unknown only", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 1,
      readyPackages: 0,
      intermediatePackages: 0,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 0,
      unknownPackages: 1,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "1 duplicate package in /project/bun.lock.\n" +
        "Compatibility could not be checked automatically for 1 package.",
    )
  })

  test("intermediate only", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 2,
      readyPackages: 0,
      intermediatePackages: 1,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 0,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "2 duplicate packages in /project/bun.lock.\n" +
        "1 intermediate package can be updated to unlock deduplication.\n" +
        "\n" +
        "Run with --update --fix to update intermediate packages and apply dedupes.",
    )
  })

  test("ready + intermediate", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 5,
      readyPackages: 2,
      intermediatePackages: 1,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 0,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "5 duplicate packages in /project/bun.lock.\n" +
        "2 packages can be deduped.\n" +
        "1 intermediate package can be updated to unlock deduplication.\n" +
        "\n" +
        "Run with --fix to apply available dedupes.\n" +
        "Run with --update --fix to update intermediate packages and apply dedupes.",
    )
  })

  test("ready + intermediate + cannot", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 7,
      readyPackages: 2,
      intermediatePackages: 1,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 2,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "7 duplicate packages in /project/bun.lock.\n" +
        "2 packages can be deduped.\n" +
        "1 intermediate package can be updated to unlock deduplication.\n" +
        "2 packages cannot be deduped.\n" +
        "\n" +
        "Run with --fix to apply available dedupes.\n" +
        "Run with --update --fix to update intermediate packages and apply dedupes.",
    )
  })

  test("intermediate + cannot", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 3,
      readyPackages: 0,
      intermediatePackages: 1,
      manualUpdatePackages: 0,
      manualUpdateDedupePackages: 0,
      cannotDedupePackages: 1,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "3 duplicate packages in /project/bun.lock.\n" +
        "1 intermediate package can be updated to unlock deduplication.\n" +
        "1 package cannot be deduped.\n" +
        "\n" +
        "Run with --update --fix to update intermediate packages and apply dedupes.",
    )
  })

  test("manual updates only — no --update --fix CTA", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 1,
      readyPackages: 0,
      intermediatePackages: 0,
      manualUpdatePackages: 1,
      manualUpdateDedupePackages: 1,
      cannotDedupePackages: 0,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "1 duplicate package in /project/bun.lock.\n" +
        "1 package can be deduped by manually updating 1 intermediate dependency.",
    )
  })
})

// --- countCannotDedupePackages ---

describe("countCannotDedupePackages", () => {
  function makeCannotDedupeGroup(
    name: string,
    requesterNodeId: string,
  ): DuplicatePackageInfo {
    return {
      name,
      targetVersion: "2.0.0",
      versions: [
        { version: "2.0.0", status: "target", requests: [] },
        {
          version: "1.0.0",
          status: "cannot-dedupe",
          requests: [
            {
              requesterNodeId,
              requesterLabel: requesterNodeId,
              dependencyName: name,
              range: "^1.0.0",
              resolvedLockKey: `${requesterNodeId}/${name}`,
              resolvedVersion: "1.0.0",
              requestPath: [],
            },
          ],
        },
      ],
    }
  }

  function makeCanDedupeGroup(name: string): DuplicatePackageInfo {
    return {
      name,
      targetVersion: "2.0.0",
      versions: [
        { version: "2.0.0", status: "target", requests: [] },
        {
          version: "1.0.0",
          status: "can-dedupe",
          dedupeTargetVersion: "2.0.0",
          requests: [],
        },
      ],
    }
  }

  function makeUpdate(
    lockKey: string,
    dependencyName: string,
  ): SuggestedUpdate {
    return {
      requesterLockKey: lockKey,
      packageName: "blocker",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      deduplicates: [
        {
          name: dependencyName,
          fromVersion: "1.0.0",
          targetVersion: "2.0.0",
        },
      ],
      constrainedBy: [
        { requesterLabel: "root", requesterPath: ["root"], range: "^1.0.0" },
      ],
    }
  }

  test("no duplicates", () => {
    expect(countCannotDedupePackages([], [])).toBe(0)
  })

  test("cannot-dedupe fully covered by update", () => {
    const groups = [makeCannotDedupeGroup("dep-a", "blocker")]
    const updates = [makeUpdate("blocker", "dep-a")]
    expect(countCannotDedupePackages(groups, updates)).toBe(0)
  })

  test("cannot-dedupe not covered by update", () => {
    const groups = [makeCannotDedupeGroup("dep-a", "other-blocker")]
    const updates = [makeUpdate("blocker", "dep-a")]
    expect(countCannotDedupePackages(groups, updates)).toBe(1)
  })

  test("mix of can-dedupe and cannot-dedupe", () => {
    const groups = [
      makeCanDedupeGroup("dep-a"),
      makeCannotDedupeGroup("dep-b", "blocker"),
      makeCannotDedupeGroup("dep-c", "other"),
    ]
    const updates = [makeUpdate("blocker", "dep-b")]
    expect(countCannotDedupePackages(groups, updates)).toBe(1)
  })
})

// --- buildFixSummary ---

describe("buildFixSummary", () => {
  test("no duplicates → clean", () => {
    expect(
      buildFixSummary({
        duplicateGroups: makeGroups(0),
        fixedPackages: 0,
        fixedEntries: 0,
        removedEntries: 0,
      }),
    ).toEqual({ kind: "clean" })
  })

  test("duplicates but nothing fixed → no-auto-fix", () => {
    expect(
      buildFixSummary({
        duplicateGroups: makeGroups(3),
        fixedPackages: 0,
        fixedEntries: 0,
        removedEntries: 0,
      }),
    ).toEqual({
      kind: "no-auto-fix",
      totalDuplicatePackages: 3,
    })
  })

  test("prune-only cleanup", () => {
    expect(
      buildFixSummary({
        duplicateGroups: makeGroups(3),
        fixedPackages: 0,
        fixedEntries: 0,
        removedEntries: 2,
      }),
    ).toEqual({
      kind: "cleaned",
      removedEntries: 2,
      remainingPackages: 3,
    })
  })

  test("all fixed, nothing remaining", () => {
    expect(
      buildFixSummary({
        duplicateGroups: makeGroups(3),
        fixedPackages: 3,
        fixedEntries: 14,
        removedEntries: 0,
      }),
    ).toEqual({
      kind: "fixed",
      fixedPackages: 3,
      fixedEntries: 14,
      removedEntries: 0,
      remainingPackages: 0,
    })
  })

  test("some fixed, some remaining", () => {
    expect(
      buildFixSummary({
        duplicateGroups: makeGroups(5),
        fixedPackages: 3,
        fixedEntries: 14,
        removedEntries: 0,
      }),
    ).toEqual({
      kind: "fixed",
      fixedPackages: 3,
      fixedEntries: 14,
      removedEntries: 0,
      remainingPackages: 2,
    })
  })
})

// --- formatFixSummary ---

describe("formatFixSummary", () => {
  test("clean", () => {
    expect(formatFixSummary({ kind: "clean" }, lockPath)).toBe(
      "All clean — no duplicate packages in /project/bun.lock.",
    )
  })

  test("no-auto-fix, singular", () => {
    expect(
      formatFixSummary(
        { kind: "no-auto-fix", totalDuplicatePackages: 1 },
        lockPath,
      ),
    ).toBe(
      "1 duplicate package in /project/bun.lock.\n" + "None can be deduped.",
    )
  })

  test("no-auto-fix, plural", () => {
    expect(
      formatFixSummary(
        { kind: "no-auto-fix", totalDuplicatePackages: 3 },
        lockPath,
      ),
    ).toBe(
      "3 duplicate packages in /project/bun.lock.\n" + "None can be deduped.",
    )
  })

  test("prune-only cleanup", () => {
    expect(
      formatFixSummary(
        { kind: "cleaned", removedEntries: 2, remainingPackages: 3 },
        lockPath,
      ),
    ).toBe(
      "Removed 2 unreachable entries from /project/bun.lock.\n" +
        "3 packages cannot be deduped.",
    )
  })

  test("fixed, nothing remaining", () => {
    expect(
      formatFixSummary(
        {
          kind: "fixed",
          fixedPackages: 3,
          fixedEntries: 14,
          removedEntries: 0,
          remainingPackages: 0,
        },
        lockPath,
      ),
    ).toBe("Deduped 14 entries across 3 packages in /project/bun.lock.")
  })

  test("fixed, some remaining", () => {
    expect(
      formatFixSummary(
        {
          kind: "fixed",
          fixedPackages: 3,
          fixedEntries: 14,
          removedEntries: 0,
          remainingPackages: 2,
        },
        lockPath,
      ),
    ).toBe(
      "Deduped 14 entries across 3 packages in /project/bun.lock.\n" +
        "2 packages cannot be deduped.",
    )
  })

  test("fixed, singular counts", () => {
    expect(
      formatFixSummary(
        {
          kind: "fixed",
          fixedPackages: 1,
          fixedEntries: 1,
          removedEntries: 0,
          remainingPackages: 1,
        },
        lockPath,
      ),
    ).toBe(
      "Deduped 1 entry across 1 package in /project/bun.lock.\n" +
        "1 package cannot be deduped.",
    )
  })

  test("mixed dedupe and cleanup", () => {
    expect(
      formatFixSummary(
        {
          kind: "fixed",
          fixedPackages: 1,
          fixedEntries: 1,
          removedEntries: 2,
          remainingPackages: 0,
        },
        lockPath,
      ),
    ).toBe(
      "Deduped 1 entry across 1 package and removed 2 unreachable entries in /project/bun.lock.",
    )
  })
})

// --- formatUpdateFixSummary ---

describe("formatUpdateFixSummary", () => {
  test("no change", () => {
    expect(formatUpdateFixSummary({ kind: "no-change" }, lockPath)).toBe(
      "No update fixes applied to /project/bun.lock.",
    )
  })

  test("no change with manual opportunities", () => {
    expect(
      formatUpdateFixSummary(
        {
          kind: "no-change",
          skippedUpdateCount: 2,
          skippedPackageCount: 2,
          skippedDedupePackageCount: 3,
        },
        lockPath,
      ),
    ).toBe(
      "No update fixes applied to /project/bun.lock.\n" +
        "3 more packages could be deduped by manually updating 2 intermediate dependencies.",
    )
  })

  test("updated and deduped", () => {
    expect(
      formatUpdateFixSummary(
        {
          kind: "updated",
          updatedEntries: 2,
          updatedPackages: 1,
          dedupedEntries: 3,
          dedupedPackages: 2,
          prunedEntries: 0,
        },
        lockPath,
      ),
    ).toBe(
      "Updated 2 entries across 1 intermediate package and deduped 3 entries across 2 packages in /project/bun.lock.",
    )
  })

  test("prune-only cleanup", () => {
    expect(
      formatUpdateFixSummary(
        {
          kind: "updated",
          updatedEntries: 0,
          updatedPackages: 0,
          dedupedEntries: 0,
          dedupedPackages: 0,
          prunedEntries: 2,
        },
        lockPath,
      ),
    ).toBe("Removed 2 unreachable entries from /project/bun.lock.")
  })

  test("updated and deduped with manual opportunities", () => {
    expect(
      formatUpdateFixSummary(
        {
          kind: "updated",
          updatedEntries: 1,
          updatedPackages: 1,
          dedupedEntries: 1,
          dedupedPackages: 1,
          prunedEntries: 0,
          skippedUpdateCount: 1,
          skippedPackageCount: 1,
          skippedDedupePackageCount: 1,
        },
        lockPath,
      ),
    ).toBe(
      "Updated 1 entry across 1 intermediate package and deduped 1 entry across 1 package in /project/bun.lock.\n" +
        "1 more package could be deduped by manually updating 1 intermediate dependency.",
    )
  })

  test("updated, deduped, and cleaned", () => {
    expect(
      formatUpdateFixSummary(
        {
          kind: "updated",
          updatedEntries: 1,
          updatedPackages: 1,
          dedupedEntries: 1,
          dedupedPackages: 1,
          prunedEntries: 2,
        },
        lockPath,
      ),
    ).toBe(
      "Updated 1 entry across 1 intermediate package and deduped 1 entry across 1 package and removed 2 unreachable entries in /project/bun.lock.",
    )
  })
})

// --- formatUpdateFixReport ---

describe("formatUpdateFixReport", () => {
  const originalLock = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "myapp", "dependencies": { "app-blocking": "^1.0.0", "shared-dep": "^2.0.0" } }
  },
  "packages": {
    "app-blocking": ["app-blocking@1.0.0", "", { "dependencies": { "shared-dep": "^1.0.0" } }, "sha-old"],
    "app-blocking/shared-dep": ["shared-dep@1.5.0", "", {}, "sha-nested"],
    "shared-dep": ["shared-dep@2.1.0", "", {}, "sha-root"]
  }
}
`
  const updatedLock = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "myapp", "dependencies": { "app-blocking": "^1.0.0", "shared-dep": "^2.0.0" } }
  },
  "packages": {
    "app-blocking": ["app-blocking@1.1.0", "", { "dependencies": { "shared-dep": "^2.0.0" } }, "sha-new"],
    "shared-dep": ["shared-dep@2.1.0", "", {}, "sha-root"]
  }
}
`
  const update: SuggestedUpdate = {
    requesterLockKey: "app-blocking",
    packageName: "app-blocking",
    fromVersion: "1.0.0",
    toVersion: "1.1.0",
    deduplicates: [
      { name: "shared-dep", fromVersion: "1.5.0", targetVersion: "2.1.0" },
    ],
    constrainedBy: [
      {
        requesterLabel: "myapp (workspace)",
        requesterPath: ["myapp"],
        range: "^1.0.0",
      },
    ],
  }

  test("reports the final lockfile instead of the pre-update analysis", () => {
    const preDuplicates = analyzeDuplicatePackages(parseBunLock(originalLock))

    const report = formatUpdateFixReport(
      preDuplicates,
      {
        changed: true,
        lockText: updatedLock,
        updatedEntries: 1,
        updatedPackages: 1,
        dedupedEntries: 1,
        dedupedPackages: 1,
        prunedEntries: 0,
        suggestedUpdates: [update],
        appliedUpdates: [update],
        skippedUpdates: [],
      },
      lockPath,
    )

    // The duplicate group no longer exists in the written lockfile, so the
    // body must not describe it as pending work.
    expect(report).toBe(
      "No fixable duplicate packages found in bun.lock.\n\n" +
        "Updated 1 entry across 1 intermediate package and deduped 1 entry across 1 package in /project/bun.lock.",
    )
  })

  test("annotates persisting blockers with skipped updates when nothing changed", () => {
    const preDuplicates = analyzeDuplicatePackages(parseBunLock(originalLock))
    const skipped = { ...update, skipReason: "dependency-conflict" as const }

    const report = formatUpdateFixReport(
      preDuplicates,
      {
        changed: false,
        lockText: originalLock,
        updatedEntries: 0,
        updatedPackages: 0,
        dedupedEntries: 0,
        dedupedPackages: 0,
        prunedEntries: 0,
        suggestedUpdates: [update],
        appliedUpdates: [],
        skippedUpdates: [skipped],
      },
      lockPath,
    )

    expect(report).toContain("✋ 1.5.0 → 2.1.0")
    expect(report).toContain("- app-blocking: 1.0.0 → 1.1.0")
    expect(report).toContain(
      "held back: update needs a dependency version this package cannot reach in the lockfile",
    )
    expect(report).toContain("No update fixes applied to /project/bun.lock.")
    expect(report).toContain(
      "1 more package could be deduped by manually updating 1 intermediate dependency.",
    )
    // The skipped update must not be rendered as an already-removed orphan.
    expect(report).not.toContain("🗑️")
  })
})
