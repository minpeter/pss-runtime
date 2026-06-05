import { describe, expect, it } from "vitest";

const removedExportNames = [
  `Default${"Tools"}`,
  "tools",
  `web${"Fetch"}Tool`,
  `web${"Search"}Tool`,
] as const;

describe("coding-agent public surface", () => {
  it("does not export bundled tools", async () => {
    const exports = await import(".");

    expect(Object.keys(exports).sort()).toEqual([
      "createCodingLanguageModel",
      "createOpenAICompatibleModelFromEnv",
    ]);
    for (const exportName of removedExportNames) {
      expect(exportName in exports).toBe(false);
    }
  });
});
