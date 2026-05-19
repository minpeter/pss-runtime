import type { LanguageModel } from "ai";
import { jsonSchema, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTools } from "./llm";
import { assistantMessage, userText } from "./test-fixtures";

const { createOpenAICompatibleMock, generateTextMock } = vi.hoisted(() => ({
  createOpenAICompatibleMock: vi.fn(),
  generateTextMock: vi.fn(),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
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

function mockEnv(apiKey = "ai-test-key") {
  vi.doMock("./env", () => ({
    env: {
      AI_API_KEY: apiKey,
      AI_BASE_URL: "https://llm.test/v1",
      AI_MODEL: "minimax/MiniMax-M2.7",
    },
  }));
}

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
    mockEnv();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
    createOpenAICompatibleMock.mockReset();
    createOpenAICompatibleMock.mockImplementation(
      (config: { apiKey?: string; baseURL: string; name: string }) =>
        (modelId: string) =>
          ({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            modelId,
            providerName: config.name,
          }) as unknown as LanguageModel
    );
  });

  afterEach(() => {
    vi.doUnmock("./env");
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

  it("keeps semicolon-delimited AI_API_KEY as one opaque provider key", async () => {
    mockEnv("ai-token-1;ai-token-2");
    const createLlm = await loadCreateLlm();
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];
    const llm = createLlm();

    await llm({ history, signal });

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({
          apiKey: "ai-token-1;ai-token-2",
          baseURL: "https://llm.test/v1",
          modelId: "minimax/MiniMax-M2.7",
        }),
      })
    );
  });
});

describe("Agent tool wiring", () => {
  beforeEach(() => {
    vi.resetModules();
    mockEnv();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
    createOpenAICompatibleMock.mockReset();
    createOpenAICompatibleMock.mockImplementation(
      (config: { apiKey?: string; baseURL: string; name: string }) =>
        (modelId: string) =>
          ({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            modelId,
            providerName: config.name,
          }) as unknown as LanguageModel
    );
  });

  afterEach(() => {
    vi.doUnmock("./env");
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
    const session = new Agent().createSession();

    await session.submit(userText("run without product tools"));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: undefined,
      })
    );
  });
});
