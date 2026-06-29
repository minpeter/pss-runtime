import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@minpeter\/pss-runtime\/execution$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/execution/index.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-runtime\/namespace$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/namespace.ts"
        ),
      },
      {
        find: /^@minpeter\/pss-runtime$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/index.ts"
        ),
      },
    ],
    conditions: ["@minpeter/pss-source", "import", "module", "default"],
  },
  test: {
    environment: "node",
  },
});
