import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/env.ts", "src/model.ts", "src/tui.ts"],
  unbundle: true,
  root: "src",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
});
