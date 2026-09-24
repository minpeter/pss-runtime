import type { LanguageModel, ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  generateSessionTitle,
  sanitizeGeneratedTitle,
} from "./session-auto-title";

const history: readonly ModelMessage[] = [
  { content: "Let's automatically create a session name", role: "user" },
  {
    content: "We'll create a title after our first response.",
    role: "assistant",
  },
];

const modelWithText = (text: string, inspect?: (options: unknown) => void) =>
  ({
    doGenerate: (options: unknown) => {
      inspect?.(options);
      return Promise.resolve({
        content: [{ text, type: "text" }],
        finishReason: { raw: undefined, unified: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      });
    },
    doStream: () => Promise.reject(new Error("Unexpected stream")),
    modelId: "title-test",
    provider: "test",
    specificationVersion: "v4",
    supportedUrls: {},
  }) as unknown as LanguageModel;

const failingModel = {
  doGenerate: () => Promise.reject(new Error("offline")),
  doStream: () => Promise.reject(new Error("Unexpected stream")),
  modelId: "title-test",
  provider: "test",
  specificationVersion: "v4",
  supportedUrls: {},
} as unknown as LanguageModel;

describe("generateSessionTitle", () => {
  it("keeps the conversation as the prompt prefix", async () => {
    const inspect = vi.fn();
    const title = await generateSessionTitle({
      history,
      instructions: "coding instructions",
      model: modelWithText("Session Auto Title", inspect),
    });

    expect(title).toBe("Session Auto Title");
    expect(inspect).toHaveBeenCalledOnce();
    expect(inspect.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 24,
      temperature: 0,
    });
    const prompt = (
      inspect.mock.calls[0]?.[0] as { prompt: ModelMessage[] } | undefined
    )?.prompt;
    expect(prompt).toBeDefined();
    if (prompt === undefined) {
      throw new Error("Expected a generated model prompt");
    }
    expect(prompt[0]).toEqual({
      content: "coding instructions",
      role: "system",
    });
    expect(prompt.slice(1, history.length + 1)).toMatchObject([
      { content: [{ text: history[0]?.content }], role: "user" },
      { content: [{ text: history[1]?.content }], role: "assistant" },
    ]);
  });

  it("falls back to a truncated first user message when generation fails", async () => {
    const title = await generateSessionTitle({
      history: [
        {
          content:
            "Generate automatic titles from long user requests while keeping the fallback readable when the model call fails",
          role: "user",
        },
        { content: "Respond", role: "assistant" },
      ],
      instructions: "coding instructions",
      model: failingModel,
    });

    expect(title).toBe("Generate automatic titles from long user requests…");
  });

  it("does not title sessions that already contain multiple user turns", async () => {
    const inspect = vi.fn();
    const title = await generateSessionTitle({
      history: [
        ...history,
        { content: "Second request", role: "user" },
        { content: "Second Response", role: "assistant" },
      ],
      instructions: "coding instructions",
      model: modelWithText("title", inspect),
    });

    expect(title).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("uses the first message fallback when a turn has no assistant text", async () => {
    const inspect = vi.fn();
    const title = await generateSessionTitle({
      history: [{ content: "Tool call session", role: "user" }],
      instructions: "coding instructions",
      model: modelWithText("unused", inspect),
    });

    expect(title).toBe("Tool call session");
    expect(inspect).not.toHaveBeenCalled();
  });
});

describe("sanitizeGeneratedTitle", () => {
  it("removes common wrappers and bounds generated titles", () => {
    expect(
      sanitizeGeneratedTitle(
        'Title: **"Automatic session title"**\nDescription'
      )
    ).toBe("Automatic session title");
    expect(sanitizeGeneratedTitle("x".repeat(50))).toBe(`${"x".repeat(39)}…`);
    expect(sanitizeGeneratedTitle(" \n ")).toBeUndefined();
  });
});
