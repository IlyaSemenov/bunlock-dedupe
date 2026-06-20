import type { Writable } from "node:stream"

// Only the registry-bound analyze pass reports progress. The phase union and
// label map let a future network-bound phase emit progress by adding a member
// here, without rebuilding the rest of the plumbing.
export type ProgressPhase = "analyze"

export type Progress = {
  phase: ProgressPhase
  /** 1-indexed position within the phase. */
  current: number
  /** Total items scheduled for this phase. */
  total: number
  /** Package name being processed for this item. */
  packageName: string
}

export type ProgressFn = (progress: Progress) => void

const PHASE_LABELS: Record<ProgressPhase, string> = {
  // The analyze pass is dominated by npm registry I/O, not local work.
  // "Checking" describes what the user actually waits on without implying
  // CPU-bound work that would make a slow request look like a hang.
  analyze: "Checking",
}

export type ProgressRenderer = {
  update: ProgressFn
  /** Clear the live progress line so the next writer starts on a fresh line. */
  end: () => void
}

/**
 * Build a TTY-aware progress renderer that writes to `stream`.
 *
 * On an interactive terminal each update overwrites the previous line, so the
 * user sees a single live line such as:
 *
 * ```
 * Checking typescript [4/27]
 * ```
 *
 * The line is cleared with the ANSI `\r\x1b[2K` sequence on every update and
 * on `end()`, so progress is purely ephemeral — when the run finishes the
 * terminal shows only the main report, with no leftover progress line in the
 * scrollback. When the stream is not a TTY (piped output, CI logs) the
 * renderer is a no-op so stdout/stderr stay clean.
 */
export function createProgressRenderer(
  stream: Pick<Writable, "write"> & { isTTY?: boolean },
): ProgressRenderer {
  if (!stream.isTTY) {
    return { update: () => {}, end: () => {} }
  }

  // `\r` moves the cursor to column 0; `\x1b[2K` erases the entire current
  // line. Together they let us atomically replace whatever is on the line.
  const clearAndWrite = (line: string): void => {
    stream.write(`\r\x1b[2K${line}`)
  }
  const clear = (): void => {
    stream.write("\r\x1b[2K")
  }

  let hasLiveLine = false

  const update: ProgressFn = (progress) => {
    const line = `${PHASE_LABELS[progress.phase]} ${progress.packageName} [${progress.current}/${progress.total}]`
    clearAndWrite(line)
    hasLiveLine = true
  }

  const end = (): void => {
    if (hasLiveLine) {
      clear()
      hasLiveLine = false
    }
  }

  return { update, end }
}
