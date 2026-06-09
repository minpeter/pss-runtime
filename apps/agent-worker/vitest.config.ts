import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["@minpeter/pss-source", "import", "module", "default"],
  },
  plugins: [
    {
      name: "agent-worker-md-loader",
      load(id) {
        if (!id.endsWith(".md")) {
          return;
        }
        return {
          code: `export default ${JSON.stringify(readFileSync(id, "utf8"))};`,
        };
      },
    },
  ],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});