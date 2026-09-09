import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

describe("CLI flags", () => {
  test.each([
    "--update",
    "--all",
    "--offline",
    "--clear-cache",
  ])("--repair rejects %s", async (flag) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "--repair", flag], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await proc.exited).toBe(1)
    expect(await new Response(proc.stderr).text()).toContain(
      "cannot be combined",
    )
  })
  test("--offline without --update exits with error", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "--offline"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    expect(exitCode).not.toBe(0)
  })

  test("--update --fix --offline exits with error", async () => {
    const proc = Bun.spawn(
      ["bun", "src/cli.ts", "--update", "--fix", "--offline"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("--offline cannot be used with --fix")
  })

  test("--refresh without --update exits with error", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "--refresh"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("--refresh is only valid with --update")
  })

  test("--refresh cannot be combined with --offline", async () => {
    const proc = Bun.spawn(
      ["bun", "src/cli.ts", "--update", "--refresh", "--offline"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("--refresh cannot be used with --offline")
  })
})

test.each([
  ["repair-pinned-ranges", "peerDependencies.vue: 3.5.21 → ^3.5.0"],
  [
    "repair-missing-dependencies",
    "bundler: restored metadata requires missing dependencies (bundled-missing)",
  ],
])("%s: --repair previews metadata and --repair --fix writes the same repair", async (fixtureName, expectedLine) => {
  const dir = mkdtempSync(path.join(tmpdir(), "bunlock-repair-cli-"))
  try {
    const fixture = path.resolve("test/fixtures", fixtureName)
    const original = readFileSync(path.join(fixture, "bun.lock"), "utf8")
    const lockPath = path.join(dir, "bun.lock")
    writeFileSync(lockPath, original)
    const preload = path.join(dir, "registry.ts")
    writeFileSync(
      preload,
      `
      import { mock } from "bun:test"
      import * as registryModule from ${JSON.stringify(path.resolve("src/registry.ts"))}
      const fetchPackageMetadata = registryModule.fetchPackageMetadata
      const registry = await Bun.file(${JSON.stringify(path.join(fixture, "registry.json"))}).json()
      const fetchFn = async (input) => {
        const name = decodeURIComponent(String(input).slice("https://registry.npmjs.org/".length))
        return new Response(JSON.stringify({ versions: registry.metadata[name] ?? {} }))
      }
      mock.module(${JSON.stringify(path.resolve("src/registry.ts"))}, () => ({
        ...registryModule,
        fetchPackageMetadata: (name, version, options) => fetchPackageMetadata(name, version, { ...options, fetchFn }),
      }))
    `,
    )
    for (const fix of [false, true]) {
      const proc = Bun.spawn(
        [
          "bun",
          "--preload",
          preload,
          "src/cli.ts",
          lockPath,
          "--repair",
          "--refresh",
          ...(fix ? ["--fix"] : []),
        ],
        { stdout: "pipe", stderr: "pipe" },
      )
      const output = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      expect({ exitCode: await proc.exited, stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      })
      expect(output).toContain(expectedLine)
      expect(output).toContain(fix ? "repaired in" : "can be repaired in")
      expect(readFileSync(lockPath, "utf8")).toBe(
        fix
          ? readFileSync(path.join(fixture, "bun.repair.lock"), "utf8")
          : original,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
