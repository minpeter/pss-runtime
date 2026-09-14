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
      {
        find: /^@minpeter\/pss-runtime\/(.+)$/,
        replacement: resolve(
          import.meta.dirname,
          "../../packages/runtime/src/$1/index.ts"
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
        branches: 60,
        functions: 82,
        lines: 75,
        statements: 75,
      },
    },
  },
});
