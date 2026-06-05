import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/plugins/index.ts",
    "src/session/store/memory.ts",
    "src/session/store/file.ts",
  ],
  unbundle: true,
  root: "src",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
});
