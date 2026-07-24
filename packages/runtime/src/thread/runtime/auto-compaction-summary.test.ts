import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import {
  buildCompactionSummaryInstructions,
  COMPACTION_SUMMARY_CONTRACT,
  summarizeCompactionRange,
} from "./auto-compaction-summary";

const SMALLER_CONTEXT_ERROR = /smaller than its source context/i;

describe("automatic compaction summary contract", () => {
  it("defines a continuation handoff with durable coding-state sections", () => {
    expect(COMPACTION_SUMMARY_CONTRACT.sections.map(({ id }) => id)).toEqual([
      "objective",
      "constraints",
      "progress",
      "decisions",
      "files",
      "tool-evidence",
      "open-work",
      "critical-values",
      "failed-approaches",
    ]);
    expect(COMPACTION_SUMMARY_CONTRACT.rules).toMatchObject({
      continueConversation: false,
      distinguishPlannedFromCompleted: true,
      mergePreviousSummary: true,
      preserveLabeledStateVerbatim: true,
      preserveLatestCorrections: true,
    });

    const instructions = buildCompactionSummaryInstructions();
    const headings = instructions
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings).toEqual(
      COMPACTION_SUMMARY_CONTRACT.sections.map(({ title }) => `## ${title}`)
    );
  });

  it("passes deterministic generation controls to the summary model", async () => {
    let captured: MockLanguageModelV4CallOptions | undefined;
    const model = createMockLanguageModelV4((options) => {
      captured = options;
      return Promise.resolve(mockLanguageModelV4Text("summary"));
    });

    await expect(
      summarizeCompactionRange({
        history: [
          { content: "project is orbit. ".repeat(20), role: "user" },
          { content: "all project facts noted", role: "assistant" },
        ],
        model: {
          maxOutputTokens: 512,
          model,
          seed: 42,
          temperature: 0,
        },
      })
    ).resolves.toBe("summary");

    expect(captured).toMatchObject({
      maxOutputTokens: 512,
      seed: 42,
      temperature: 0,
    });
  });

  it("rejects a summary that does not reduce the source context", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("x".repeat(4000)))
    );

    await expect(
      summarizeCompactionRange({
        history: [
          { content: "short source fact", role: "user" },
          { content: "noted", role: "assistant" },
        ],
        model: { model },
      })
    ).rejects.toThrow(SMALLER_CONTEXT_ERROR);
  });

  it("does not count generated summary instructions as source context", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("y".repeat(300)))
    );

    await expect(
      summarizeCompactionRange({
        history: [
          { content: "tiny source", role: "user" },
          { content: "noted", role: "assistant" },
        ],
        model: { model },
      })
    ).rejects.toThrow(SMALLER_CONTEXT_ERROR);
  });

  it("includes the model-facing compaction wrapper in summary size", async () => {
    const model = createMockLanguageModelV4(() =>
      Promise.resolve(mockLanguageModelV4Text("compact fact"))
    );

    await expect(
      summarizeCompactionRange({
        history: [{ content: "z".repeat(80), role: "user" }],
        model: { model },
      })
    ).rejects.toThrow(SMALLER_CONTEXT_ERROR);
  });
});
