import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: "esm",
  sourcemap: true,
  exports: true,
  dts: true,
})
