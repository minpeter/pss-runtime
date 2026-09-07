import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve runtime integration tests to source in Vite, not via a static
    // cross-package import that also enters tsdown's declaration graph.
    alias: [
      {
        find: /^@minpeter\/pss-runtime$/,
        replacement: fileURLToPath(
          new URL("../../packages/runtime/src/index.ts", import.meta.url)
        ),
      },
    ],
    conditions: ["@minpeter/pss-source", "import", "module", "default"],
  },
  test: {
    environment: "node",
  },
});
