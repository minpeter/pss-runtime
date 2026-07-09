import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@minpeter\/pss-runtime\/platform\/cloudflare$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/platform/cloudflare/index.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-runtime$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/index.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-runtime\/platform\/file$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/platform/file/index.ts"
        ),
      },
      {
        find: /^cloudflare:workers$/,
        replacement: resolve(
          import.meta.dirname,
          "src/cloudflare-workers-test-shim.ts"
        ),
      },
      {
        find: /^agents$/,
        replacement: resolve(import.meta.dirname, "src/agents-test-shim.ts"),
      },
    ],
    conditions: ["@minpeter/pss-source", "import", "module", "default"],
  },
  test: {
    environment: "node",
  },
});
