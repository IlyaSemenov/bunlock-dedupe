import JSON5 from "json5"

import type { BunLockFile, DependencyMap } from "./types"

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function normalizeDependencyMap(value: unknown): DependencyMap {
  if (!isObject(value)) {
    return {}
  }

  const normalized: DependencyMap = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      normalized[key] = item
    }
  }

  return normalized
}

export function parseResolvedSpec(
  spec: string,
): { name: string; version: string } | null {
  const atIndex = spec.lastIndexOf("@")
  if (atIndex <= 0 || atIndex >= spec.length - 1) {
    return null
  }

  const name = spec.slice(0, atIndex)
  const version = spec.slice(atIndex + 1)
  if (!name || !version) {
    return null
  }

  return { name, version }
}

export function parseBunLock(lockText: string): BunLockFile {
  const parsed = JSON5.parse(lockText)
  if (!isObject(parsed)) {
    throw new Error("bun.lock must parse to an object")
  }

  return parsed as BunLockFile
}
