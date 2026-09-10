import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests use fixed config and do not need hot reload.
    env: { WRANGLER_CI_DISABLE_CONFIG_WATCHING: "true" },
    include: ["test/**/*.test.mjs"],
    hookTimeout: 30_000,
    testTimeout: 10_000,
    fileParallelism: false,
  },
});
