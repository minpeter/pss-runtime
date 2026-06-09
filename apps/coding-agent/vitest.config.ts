import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["@minpeter/pss-source", "import", "module", "default"],
  },
  test: {
    env: {
      EXA_API_KEY: "test-exa-key",
    },
    environment: "node",
  },
});
