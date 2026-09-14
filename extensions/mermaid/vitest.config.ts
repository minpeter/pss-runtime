import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@minpeter\/pss-coding-agent\/extension$/,
        replacement: resolve(
          import.meta.dirname,
          "../../apps/coding-agent/src/extensions/index.ts"
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
    coverage: {
      exclude: ["src/**/*.test.ts"],
      include: ["src/**/*.ts"],
      provider: "v8",
      reportsDirectory: "coverage",
      thresholds: {
        branches: 78,
        functions: 88,
        lines: 88,
        statements: 88,
      },
    },
  },
});
