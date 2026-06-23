import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/channel/index.ts",
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
  inputOptions: {
    // The dts pipeline (rolldown-plugin-dts:fake-js) intentionally emits no
    // sourcemap for `.d.ts` chunks, which triggers a spurious SOURCEMAP_BROKEN
    // warning even though the published `.js.map` files are correct. Drop only
    // that one log and let every other warning through.
    onLog(level, log, defaultHandler) {
      if (log.code === "SOURCEMAP_BROKEN") {
        return;
      }
      defaultHandler(level, log);
    },
  },
});
