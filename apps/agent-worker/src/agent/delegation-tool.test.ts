import { InMemoryCloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import type { LanguageModel, Tool, ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return {
    ...actual,
    createLanguageModel: () => ({}) as LanguageModel,
  };
});

const fakeAssistantMessage = {
  content: [{ text: "DONE", type: "text" }],
  role: "assistant" as const,
};

const testBindings = {
  AI_API_KEY: "test-key",
  EXA_API_KEY: "test-exa-key",
} as const;

const sessionKey = "telegram:thread-1:user-1";
const storePrefix = "telegram-chat:thread-1:user-1";

function lastGenerateTextTools(): ToolSet {
  const call = generateTextMock.mock.calls.at(-1)?.[0] as
    | { tools?: ToolSet }
    | undefined;
  return call?.tools ?? {};
}

function executableTool(tools: ToolSet, name: string): Tool {
  const candidate = tools[name];
  expect(candidate).toBeDefined();
  expect(candidate?.execute).toBeTypeOf("function");
  return candidate as Tool;
}

function toolExecutionOptions(signal = new AbortController().signal) {
  return {
    abortSignal: signal,
    context: undefined,
    messages: [],
    toolCallId: "call_delegate_1",
  };
}

async function drainRun(run: { events(): AsyncIterable<unknown> }) {
  for await (const _event of run.events()) {
    // Drain events so tool registration completes.
  }
}

describe("sendmessageto_agent delegation baseline", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [fakeAssistantMessage],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a durable background task_id when sendmessageto_agent executes", async () => {
    const { createChatAgent } = await import("./factory");
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const agent = createChatAgent(storage, storePrefix, testBindings, {
      sessionKey,
    });

    await drainRun(await agent.session(sessionKey).send("delegate"));

    const delegate = executableTool(
      lastGenerateTextTools(),
      "sendmessageto_agent"
    );
    const result = await delegate.execute?.(
      { prompt: "search typescript release notes" },
      toolExecutionOptions()
    );

    expect(result).toMatchObject({
      run_in_background: true,
      status: "pending",
    });
    expect(result).toEqual(
      expect.objectContaining({
        task_id: expect.stringMatching(/^bg_/),
      })
    );
  });

  it("rejects non-string delegate prompts", async () => {
    const { createChatAgent } = await import("./factory");
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const agent = createChatAgent(storage, storePrefix, testBindings, {
      sessionKey,
    });

    await drainRun(await agent.session(sessionKey).send("delegate"));

    const delegate = executableTool(
      lastGenerateTextTools(),
      "sendmessageto_agent"
    );
    await expect(
      delegate.execute?.(
        { prompt: { query: "broken" } },
        toolExecutionOptions()
      )
    ).rejects.toThrow("Delegate prompt must be a plain string.");
  });

  it("does not expose background_output or background_cancel on the chat agent", async () => {
    const { createChatAgent } = await import("./factory");
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const agent = createChatAgent(storage, storePrefix, testBindings, {
      sessionKey,
    });

    await drainRun(await agent.session(sessionKey).send("delegate"));

    const tools = lastGenerateTextTools();
    expect(tools).not.toHaveProperty("background_output");
    expect(tools).not.toHaveProperty("background_cancel");
  });
});