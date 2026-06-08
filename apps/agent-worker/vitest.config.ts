import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@minpeter/pss-runtime/cloudflare",
        replacement: fileURLToPath(
          new URL(
            "../../packages/runtime/src/cloudflare/index.ts",
            import.meta.url
          )
        ),
      },
      {
        find: "@minpeter/pss-runtime/execution",
        replacement: fileURLToPath(
          new URL(
            "../../packages/runtime/src/execution/index.ts",
            import.meta.url
          )
        ),
      },
      {
        find: "@minpeter/pss-runtime",
        replacement: fileURLToPath(
          new URL("../../packages/runtime/src/index.ts", import.meta.url)
        ),
      },
    ],
    conditions: ["@minpeter/pss-source"],
  },
});
