import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/env/index.ts"],
  unbundle: true,
  root: "src",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
});