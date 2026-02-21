import { expect, test } from "bun:test"

import {
  compareLockKeysByNesting,
  getLockKeyNestingDepth,
} from "../src/dedupe/utils"

test("computes bun.lock nesting depth for scoped and unscoped keys", () => {
  const depthByKey = new Map([
    ["typescript", 0],
    ["@manypkg/find-root", 0],
    ["micromatch/picomatch", 1],
    ["@manypkg/find-root/fs-extra", 1],
    ["bun-types/@types/node", 1],
    ["bun-types/@types/node/undici-types", 2],
    ["@scope/a/@scope/b/pkg", 2],
  ])

  for (const [lockKey, expectedDepth] of depthByKey) {
    expect(getLockKeyNestingDepth(lockKey)).toBe(expectedDepth)
  }
})

test("sorts bun.lock keys by nesting depth, then by package path", () => {
  const keys = [
    "read-yaml-file/js-yaml/argparse",
    "read-yaml-file/js-yaml",
    "@manypkg/find-root",
    "bun-types/@types/node",
    "bun-types/@types/node/undici-types",
    "which",
    "@manypkg/find-root/fs-extra",
  ]

  expect([...keys].sort(compareLockKeysByNesting)).toEqual([
    "@manypkg/find-root",
    "which",
    "@manypkg/find-root/fs-extra",
    "bun-types/@types/node",
    "read-yaml-file/js-yaml",
    "bun-types/@types/node/undici-types",
    "read-yaml-file/js-yaml/argparse",
  ])
})

test("sorts same-depth keys by package segments, not raw key string", () => {
  const keys = [
    "@parcel/watcher-wasm/napi-wasm",
    "@parcel/watcher/node-addon-api",
    "nuxt-auth-utils/hookable",
    "nuxt/escape-string-regexp",
    "stylelint-scss/mdn-data",
    "stylelint/file-entry-cache",
  ]

  expect([...keys].sort(compareLockKeysByNesting)).toEqual([
    "@parcel/watcher/node-addon-api",
    "@parcel/watcher-wasm/napi-wasm",
    "nuxt/escape-string-regexp",
    "nuxt-auth-utils/hookable",
    "stylelint/file-entry-cache",
    "stylelint-scss/mdn-data",
  ])
})
