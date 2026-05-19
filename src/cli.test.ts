import { describe, expect, test } from "bun:test"

describe("CLI flags", () => {
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
})
