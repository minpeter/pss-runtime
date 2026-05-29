import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@minpeter/pss-runtime": resolve(
        import.meta.dirname,
        "../runtime/src/index.ts"
      ),
    },
  },
});
