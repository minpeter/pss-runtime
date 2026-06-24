import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@minpeter\/pss-runtime\/cloudflare$/,
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
        find: /^@minpeter\/pss-runtime\/node$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/platform/node/index.ts"
        ),
      },
      {
        find: /^cloudflare:workers$/,
        replacement: resolve(
          import.meta.dirname,
          "src/cloudflare-workers-test-shim.ts"
        ),
      },
    ],
    conditions: ["@minpeter/pss-source", "import", "module", "default"],
  },
  test: {
    environment: "node",
  },
});
