import { describe, expect, it, vi } from "vitest";
import { parsePrepareModelStepResult } from "./model-step-selection";

describe("parsePrepareModelStepResult", () => {
  it("accepts a doGenerate-only language model", () => {
    const model = {
      doGenerate: vi.fn(),
      modelId: "generate-only-model",
      provider: "fixture-provider",
      specificationVersion: "v4",
      supportedUrls: {},
    };

    expect(parsePrepareModelStepResult({ model }, 0)).toEqual({ model });
  });
});
