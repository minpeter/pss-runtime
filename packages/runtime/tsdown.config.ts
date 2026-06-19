import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/platform/cloudflare/index.ts",
    "src/platform/node/index.ts",
    "src/execution/index.ts",
    "src/execution/memory.ts",
    "src/namespace.ts",
    "src/thread/store/memory.ts",
    "src/thread/store/file.ts",
  ],
  unbundle: true,
  root: "src",
  fixedExtension: false,
  sourcemap: true,
  dts: true,
});
