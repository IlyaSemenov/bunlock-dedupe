import { describe, expect, test } from "bun:test"

import {
  buildAnalyzeSummary,
  buildFixSummary,
  formatAnalyzeSummary,
  formatFixSummary,
} from "../src/cli-messages"
import type { DuplicatePackageInfo } from "../src/dedupe/types"

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
