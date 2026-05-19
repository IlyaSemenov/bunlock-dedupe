import { describe, expect, test } from "bun:test"

import {
  buildAnalyzeSummary,
  buildFixSummary,
  buildUpdateSummary,
  formatAnalyzeSummary,
  formatFixSummary,
  formatUpdateFixSummary,
  formatUpdateSummary,
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

describe("buildAnalyzeSummary", () => {
  test("no duplicates → clean", () => {
    expect(buildAnalyzeSummary(makeGroups(0), 0, 0)).toEqual({ kind: "clean" })
  })

  test("duplicates but nothing fixable → no-auto-fix", () => {
    expect(buildAnalyzeSummary(makeGroups(3), 0, 0)).toEqual({
      kind: "no-auto-fix",
      totalDuplicatePackages: 3,
    })
  })

  test("all duplicates fixable", () => {
    expect(buildAnalyzeSummary(makeGroups(3), 3, 14)).toEqual({
      kind: "fixable",
      totalDuplicatePackages: 3,
      fixablePackages: 3,
      fixableEntries: 14,
    })
  })

  test("some duplicates fixable", () => {
    expect(buildAnalyzeSummary(makeGroups(5), 3, 14)).toEqual({
      kind: "fixable",
      totalDuplicatePackages: 5,
      fixablePackages: 3,
      fixableEntries: 14,
    })
  })
})

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

describe("formatAnalyzeSummary", () => {
  test("clean", () => {
    expect(formatAnalyzeSummary({ kind: "clean" }, lockPath)).toBe(
      "All clean — no duplicate packages in /project/bun.lock.",
    )
  })

  test("no-auto-fix, singular", () => {
    expect(
      formatAnalyzeSummary(
        { kind: "no-auto-fix", totalDuplicatePackages: 1 },
        lockPath,
      ),
    ).toBe(
      "Found 1 duplicate package in /project/bun.lock, none can be deduped.",
    )
  })

  test("no-auto-fix, plural", () => {
    expect(
      formatAnalyzeSummary(
        { kind: "no-auto-fix", totalDuplicatePackages: 3 },
        lockPath,
      ),
    ).toBe(
      "Found 3 duplicate packages in /project/bun.lock, none can be deduped.",
    )
  })

  test("fixable, all packages fixable", () => {
    expect(
      formatAnalyzeSummary(
        {
          kind: "fixable",
          totalDuplicatePackages: 3,
          fixablePackages: 3,
          fixableEntries: 14,
        },
        lockPath,
      ),
    ).toBe(
      "Found 3 duplicate packages in /project/bun.lock.\n" +
        "Ready to dedupe: 3 packages, 14 entries.\n" +
        "Run with --fix to apply.",
    )
  })

  test("fixable, some packages skipped", () => {
    expect(
      formatAnalyzeSummary(
        {
          kind: "fixable",
          totalDuplicatePackages: 5,
          fixablePackages: 3,
          fixableEntries: 14,
        },
        lockPath,
      ),
    ).toBe(
      "Found 5 duplicate packages in /project/bun.lock.\n" +
        "Ready to dedupe: 3 packages, 14 entries (2 packages cannot be deduped).\n" +
        "Run with --fix to apply.",
    )
  })

  test("fixable, singular counts", () => {
    expect(
      formatAnalyzeSummary(
        {
          kind: "fixable",
          totalDuplicatePackages: 2,
          fixablePackages: 1,
          fixableEntries: 1,
        },
        lockPath,
      ),
    ).toBe(
      "Found 2 duplicate packages in /project/bun.lock.\n" +
        "Ready to dedupe: 1 package, 1 entry (1 package cannot be deduped).\n" +
        "Run with --fix to apply.",
    )
  })
})

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
      "Found 1 duplicate package in /project/bun.lock, none can be deduped.",
    )
  })

  test("no-auto-fix, plural", () => {
    expect(
      formatFixSummary(
        { kind: "no-auto-fix", totalDuplicatePackages: 3 },
        lockPath,
      ),
    ).toBe(
      "Found 3 duplicate packages in /project/bun.lock, none can be deduped.",
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
      "Deduped 14 entries across 3 packages in /project/bun.lock (2 packages cannot be deduped).",
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
      "Deduped 1 entry across 1 package in /project/bun.lock (1 package cannot be deduped).",
    )
  })
})

describe("buildUpdateSummary", () => {
  function makeCannotDedupeGroup(name: string): DuplicatePackageInfo {
    return {
      name,
      targetVersion: "2.0.0",
      versions: [
        {
          version: "2.0.0",
          status: "target",
          requests: [],
        },
        {
          version: "1.0.0",
          status: "cannot-dedupe",
          requests: [
            {
              requesterNodeId: "blocker",
              requesterLabel: "blocker",
              dependencyName: name,
              range: "^1.0.0",
              resolvedLockKey: "blocker/dep",
              resolvedVersion: "1.0.0",
              requestPath: [],
            },
          ],
        },
      ],
    }
  }

  function makeUpdate(packageName: string, lockKey: string): SuggestedUpdate {
    return {
      requesterLockKey: lockKey,
      packageName,
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
    expect(buildUpdateSummary([], [])).toEqual({
      totalDuplicatePackages: 0,
      cannotDedupePackages: 0,
      suggestedUpdateCount: 0,
      suggestedPackageCount: 0,
    })
  })

  test("all can-dedupe, no cannot-dedupe", () => {
    const groups = makeGroups(3)
    expect(buildUpdateSummary(groups, [])).toEqual({
      totalDuplicatePackages: 3,
      cannotDedupePackages: 0,
      suggestedUpdateCount: 0,
      suggestedPackageCount: 0,
    })
  })

  test("cannot-dedupe with suggestions", () => {
    const groups = [
      ...makeGroups(1),
      makeCannotDedupeGroup("dep-a"),
      makeCannotDedupeGroup("dep-b"),
    ]
    const updates = [
      makeUpdate("blocker", "blocker"),
      makeUpdate("blocker", "plugin/blocker"),
    ]
    expect(buildUpdateSummary(groups, updates)).toEqual({
      totalDuplicatePackages: 3,
      cannotDedupePackages: 2,
      suggestedUpdateCount: 2,
      suggestedPackageCount: 1,
    })
  })

  test("cannot-dedupe without suggestions", () => {
    const groups = [makeCannotDedupeGroup("dep-a")]
    expect(buildUpdateSummary(groups, [])).toEqual({
      totalDuplicatePackages: 1,
      cannotDedupePackages: 1,
      suggestedUpdateCount: 0,
      suggestedPackageCount: 0,
    })
  })
})

describe("formatUpdateSummary", () => {
  test("clean", () => {
    expect(
      formatUpdateSummary(
        {
          totalDuplicatePackages: 0,
          cannotDedupePackages: 0,
          suggestedUpdateCount: 0,
          suggestedPackageCount: 0,
        },
        lockPath,
      ),
    ).toBe("All clean — no duplicate packages in /project/bun.lock.")
  })

  test("all can-dedupe", () => {
    expect(
      formatUpdateSummary(
        {
          totalDuplicatePackages: 3,
          cannotDedupePackages: 0,
          suggestedUpdateCount: 0,
          suggestedPackageCount: 0,
        },
        lockPath,
      ),
    ).toBe(
      "Found 3 duplicate packages in /project/bun.lock, all can be deduped.",
    )
  })

  test("cannot-dedupe, no suggestions", () => {
    expect(
      formatUpdateSummary(
        {
          totalDuplicatePackages: 4,
          cannotDedupePackages: 2,
          suggestedUpdateCount: 0,
          suggestedPackageCount: 0,
        },
        lockPath,
      ),
    ).toBe(
      "Found 4 duplicate packages in /project/bun.lock, 2 packages cannot be deduped. No intermediate updates found.",
    )
  })

  test("suggestions found", () => {
    expect(
      formatUpdateSummary(
        {
          totalDuplicatePackages: 5,
          cannotDedupePackages: 3,
          suggestedUpdateCount: 2,
          suggestedPackageCount: 1,
        },
        lockPath,
      ),
    ).toBe(
      "Found 5 duplicate packages in /project/bun.lock, 1 intermediate package can be updated to unlock deduplication.",
    )
  })

  test("suggestions found, plural packages", () => {
    expect(
      formatUpdateSummary(
        {
          totalDuplicatePackages: 5,
          cannotDedupePackages: 3,
          suggestedUpdateCount: 3,
          suggestedPackageCount: 2,
        },
        lockPath,
      ),
    ).toBe(
      "Found 5 duplicate packages in /project/bun.lock, 2 intermediate packages can be updated to unlock deduplication.",
    )
  })
})

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
      "No update fixes applied to /project/bun.lock. 3 more packages could be deduped by manually updating 2 intermediate dependencies.",
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
      "Updated 1 entry across 1 intermediate package and deduped 1 entry across 1 package in /project/bun.lock. 1 more package could be deduped by manually updating 1 intermediate dependency.",
    )
  })
})
