import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/cloudflare/index.ts",
    "src/execution/index.ts",
    "src/execution/memory.ts",
    "src/namespace.ts",
    "src/session/store/memory.ts",
    "src/session/store/file.ts",
  ],
  unbundle: true,
  root: "src",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
});
