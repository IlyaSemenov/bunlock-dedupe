import { describe, expect, test } from "bun:test"

import {
  buildFixSummary,
  countCannotDedupePackages,
  formatFixSummary,
  formatReportSummary,
  formatUpdateFixSummary,
  type ReportSummary,
} from "./cli-messages"
import type { DuplicatePackageInfo, SuggestedUpdate } from "./dedupe"

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
      cannotDedupePackages: 1,
    }
    expect(formatReportSummary(summary, lockPath)).toBe(
      "1 duplicate package in /project/bun.lock.\n" +
        "1 package cannot be deduped.",
    )
  })

  test("intermediate only", () => {
    const summary: ReportSummary = {
      totalDuplicatePackages: 2,
      readyPackages: 0,
      intermediatePackages: 1,
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

  function makeUpdate(lockKey: string): SuggestedUpdate {
    return {
      requesterLockKey: lockKey,
      packageName: "blocker",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      deduplicates: [
        { name: "dep", fromVersion: "1.0.0", targetVersion: "2.0.0" },
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
    const updates = [makeUpdate("blocker")]
    expect(countCannotDedupePackages(groups, updates)).toBe(0)
  })

  test("cannot-dedupe not covered by update", () => {
    const groups = [makeCannotDedupeGroup("dep-a", "other-blocker")]
    const updates = [makeUpdate("blocker")]
    expect(countCannotDedupePackages(groups, updates)).toBe(1)
  })

  test("mix of can-dedupe and cannot-dedupe", () => {
    const groups = [
      makeCanDedupeGroup("dep-a"),
      makeCannotDedupeGroup("dep-b", "blocker"),
      makeCannotDedupeGroup("dep-c", "other"),
    ]
    const updates = [makeUpdate("blocker")]
    expect(countCannotDedupePackages(groups, updates)).toBe(1)
  })
})

// --- buildFixSummary ---

describe("buildFixSummary", () => {
  test("no duplicates → clean", () => {
    expect(buildFixSummary(makeGroups(0), 0, 0)).toEqual({ kind: "clean" })
  })

  test("duplicates but nothing fixed → no-auto-fix", () => {
    expect(buildFixSummary(makeGroups(3), 0, 0)).toEqual({
      kind: "no-auto-fix",
      totalDuplicatePackages: 3,
    })
  })

  test("all fixed, nothing remaining", () => {
    expect(buildFixSummary(makeGroups(3), 3, 14)).toEqual({
      kind: "fixed",
      fixedPackages: 3,
      fixedEntries: 14,
      remainingPackages: 0,
    })
  })

  test("some fixed, some remaining", () => {
    expect(buildFixSummary(makeGroups(5), 3, 14)).toEqual({
      kind: "fixed",
      fixedPackages: 3,
      fixedEntries: 14,
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

  test("fixed, nothing remaining", () => {
    expect(
      formatFixSummary(
        {
          kind: "fixed",
          fixedPackages: 3,
          fixedEntries: 14,
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
          remainingPackages: 1,
        },
        lockPath,
      ),
    ).toBe(
      "Deduped 1 entry across 1 package in /project/bun.lock.\n" +
        "1 package cannot be deduped.",
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
        },
        lockPath,
      ),
    ).toBe(
      "Updated 2 entries across 1 intermediate package and deduped 3 entries across 2 packages in /project/bun.lock.",
    )
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
})
