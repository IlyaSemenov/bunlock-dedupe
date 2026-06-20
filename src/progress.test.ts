import { describe, expect, test } from "bun:test"

import { createProgressRenderer } from "./progress"

type FakeStream = {
  writes: string[]
  isTTY: boolean
  write(chunk: string): boolean
}

function makeStream(isTTY: boolean): FakeStream {
  return {
    writes: [],
    isTTY,
    write(chunk: string) {
      this.writes.push(chunk)
      return true
    },
  }
}

// `\r\x1b[2K` clears the current line and moves the cursor to column 0.
const CLEAR = "\r\x1b[2K"

describe("createProgressRenderer", () => {
  test("is a no-op when the stream is not a TTY", () => {
    const stream = makeStream(false)
    const renderer = createProgressRenderer(stream)

    renderer.update({
      phase: "analyze",
      current: 1,
      total: 5,
      packageName: "pkg",
    })
    renderer.end()

    expect(stream.writes).toEqual([])
  })

  test("clears and writes the line on each update", () => {
    const stream = makeStream(true)
    const renderer = createProgressRenderer(stream)

    renderer.update({
      phase: "analyze",
      current: 1,
      total: 3,
      packageName: "short",
    })
    renderer.update({
      phase: "analyze",
      current: 2,
      total: 3,
      packageName: "short",
    })

    expect(stream.writes).toEqual([
      `${CLEAR}Checking short [1/3]`,
      `${CLEAR}Checking short [2/3]`,
    ])
  })

  test("does not pad shorter lines — clear-and-rewrite handles any length", () => {
    const stream = makeStream(true)
    const renderer = createProgressRenderer(stream)

    renderer.update({
      phase: "analyze",
      current: 1,
      total: 100,
      packageName: "very-long-package-name",
    })
    renderer.update({
      phase: "analyze",
      current: 2,
      total: 100,
      packageName: "tiny",
    })

    expect(stream.writes[1]).toBe(`${CLEAR}Checking tiny [2/100]`)
  })

  test("end() clears the live line so the report can replace it", () => {
    const stream = makeStream(true)
    const renderer = createProgressRenderer(stream)

    renderer.update({
      phase: "analyze",
      current: 1,
      total: 1,
      packageName: "pkg",
    })
    renderer.end()

    expect(stream.writes).toEqual([`${CLEAR}Checking pkg [1/1]`, CLEAR])
  })

  test("end() is silent when no update has been emitted", () => {
    const stream = makeStream(true)
    const renderer = createProgressRenderer(stream)

    renderer.end()

    expect(stream.writes).toEqual([])
  })

  test("end() after end() does not emit a second clear", () => {
    const stream = makeStream(true)
    const renderer = createProgressRenderer(stream)

    renderer.update({
      phase: "analyze",
      current: 1,
      total: 1,
      packageName: "pkg",
    })
    renderer.end()
    renderer.end()

    expect(stream.writes).toEqual([`${CLEAR}Checking pkg [1/1]`, CLEAR])
  })

  test("end() after multiple updates still clears the live line once", () => {
    const stream = makeStream(true)
    const renderer = createProgressRenderer(stream)

    renderer.update({
      phase: "analyze",
      current: 1,
      total: 2,
      packageName: "pkg",
    })
    renderer.update({
      phase: "analyze",
      current: 2,
      total: 2,
      packageName: "pkg",
    })
    renderer.end()

    expect(stream.writes).toEqual([
      `${CLEAR}Checking pkg [1/2]`,
      `${CLEAR}Checking pkg [2/2]`,
      CLEAR,
    ])
  })

  test("total of 0 renders without division or empty brackets", () => {
    const stream = makeStream(true)
    const renderer = createProgressRenderer(stream)

    renderer.update({
      phase: "analyze",
      current: 1,
      total: 0,
      packageName: "pkg",
    })

    expect(stream.writes).toEqual([`${CLEAR}Checking pkg [1/0]`])
  })
})
