import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const workspaceSource = (path: string) =>
  fileURLToPath(new URL(`../../${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@minpeter/pss-runtime/cloudflare",
        replacement: workspaceSource(
          "packages/runtime/src/cloudflare/index.ts"
        ),
      },
      {
        find: "@minpeter/pss-runtime/execution/memory",
        replacement: workspaceSource(
          "packages/runtime/src/execution/memory.ts"
        ),
      },
      {
        find: "@minpeter/pss-web-tools/env",
        replacement: workspaceSource("packages/pss-web-tools/src/env/index.ts"),
      },
      {
        find: "@minpeter/pss-runtime",
        replacement: workspaceSource("packages/runtime/src/index.ts"),
      },
      {
        find: "@minpeter/pss-web-tools",
        replacement: workspaceSource("packages/pss-web-tools/src/index.ts"),
      },
    ],
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
