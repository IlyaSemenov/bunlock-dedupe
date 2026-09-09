import type { BunLockFile } from "./parse"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function renderInlineValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => renderInlineValue(item)).join(", ")}]`
  }

  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(
        ([key, item]) => `${JSON.stringify(key)}: ${renderInlineValue(item)}`,
      )

    if (entries.length === 0) {
      return "{}"
    }

    return `{ ${entries.join(", ")} }`
  }

  const serialized = JSON.stringify(value)
  return serialized === undefined ? "null" : serialized
}

function renderPackagesPropertyLines(
  key: string,
  value: Record<string, unknown>,
  indentLevel: number,
  trailingComma: boolean,
): string[] {
  const indent = " ".repeat(indentLevel)
  const entryIndent = " ".repeat(indentLevel + 2)
  const lines = [`${indent}${JSON.stringify(key)}: {`]
  const packageEntries = Object.entries(value).filter(
    ([, packageEntry]) => packageEntry !== undefined,
  )

  for (const [index, [lockKey, packageEntry]] of packageEntries.entries()) {
    lines.push(
      `${entryIndent}${JSON.stringify(lockKey)}: ${renderInlineValue(packageEntry)},`,
    )
    if (index < packageEntries.length - 1) {
      lines.push("")
    }
  }

  lines.push(`${indent}}${trailingComma ? "," : ""}`)
  return lines
}

function renderObjectLines(
  value: Record<string, unknown>,
  indentLevel: number,
  allowPackagesFormatting: boolean,
): string[] {
  const indent = " ".repeat(indentLevel)
  const propertyIndent = " ".repeat(indentLevel + 2)
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)

  if (entries.length === 0) {
    return [`${indent}{}`]
  }

  const lines = [`${indent}{`]
  for (const [index, [key, item]] of entries.entries()) {
    const trailingComma = index < entries.length - 1

    if (allowPackagesFormatting && key === "packages" && isRecord(item)) {
      lines.push(
        ...renderPackagesPropertyLines(
          key,
          item,
          indentLevel + 2,
          trailingComma,
        ),
      )
      continue
    }

    if (isRecord(item)) {
      const nestedLines = renderObjectLines(item, indentLevel + 2, false)
      if (nestedLines.length === 1) {
        const inlineObject = nestedLines[0]?.trimStart() ?? "{}"
        lines.push(`${propertyIndent}${JSON.stringify(key)}: ${inlineObject},`)
        continue
      }

      lines.push(
        `${propertyIndent}${JSON.stringify(key)}: ${nestedLines[0]?.trimStart() ?? "{"}`,
      )
      lines.push(...nestedLines.slice(1, -1))
      lines.push(`${nestedLines[nestedLines.length - 1]},`)
      continue
    }

    lines.push(
      `${propertyIndent}${JSON.stringify(key)}: ${renderInlineValue(item)},`,
    )
  }

  lines.push(`${indent}}`)
  return lines
}

/** Render Bun package tuples inline while preserving lock key order. */
export function renderBunLock(lock: BunLockFile): string {
  const rootObject = lock as unknown as Record<string, unknown>
  return `${renderObjectLines(rootObject, 0, true).join("\n")}\n`
}
