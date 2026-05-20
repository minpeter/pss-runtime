import type { LanguageModel } from "ai";
import { jsonSchema, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTools } from "./llm";
import { assistantMessage, userText } from "./test-fixtures";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();

  return {
    ...actual,
    generateText: generateTextMock,
  };
});

const fakeModel = {} as LanguageModel;

const createNoopTool = () =>
  tool({
    description: "No-op test tool.",
    execute: () => ({}),
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    outputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
  });

async function loadCreateLlm() {
  const { createLlm } = await import("./llm");
  return createLlm;
}

async function loadAgent() {
  const { Agent } = await import("./agent");
  return Agent;
}

describe("createLlm", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes injected tools to generateText", async () => {
    const createLlm = await loadCreateLlm();
    const injectedTools = { injected: createNoopTool() } satisfies AgentTools;
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];
    const llm = createLlm({
      instructions: "test instructions",
      model: fakeModel,
      tools: injectedTools,
    });

    await expect(llm({ history, signal })).resolves.toEqual([
      assistantMessage("DONE"),
    ]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: signal,
        instructions: "test instructions",
        messages: history,
        model: fakeModel,
        tools: injectedTools,
      })
    );
  });
});

describe("Agent tool wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes injected AgentOptions tools into createLlm/generateText", async () => {
    const Agent = await loadAgent();
    const injectedTools = { injected: createNoopTool() } satisfies AgentTools;
    const session = new Agent({
      model: fakeModel,
      tools: injectedTools,
    }).createSession();

    await session.submit(userText("use injected tools"));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
        tools: injectedTools,
      })
    );
  });

  it("does not attach product tools by default", async () => {
    const Agent = await loadAgent();
    const session = new Agent({ model: fakeModel }).createSession();

    await session.submit(userText("run without product tools"));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: undefined,
      })
    );
  });
});
