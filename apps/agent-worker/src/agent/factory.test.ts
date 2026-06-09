import { InMemoryCloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import type { LanguageModel, ToolSet } from "ai";
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

const testSessionKey = "telegram:thread-1:user-1";

function toolJsonSchema(tool: unknown): unknown {
  return (tool as { readonly inputSchema?: { readonly jsonSchema?: unknown } })
    .inputSchema?.jsonSchema;
}

function lastGenerateTextTools(): ToolSet {
  const call = generateTextMock.mock.calls.at(-1)?.[0] as
    | { tools?: ToolSet }
    | undefined;
  return call?.tools ?? {};
}

async function drainRun(run: { events(): AsyncIterable<unknown> }) {
  for await (const _event of run.events()) {
    // Drain events so tool registration completes.
  }
}

describe("createChatAgent", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [fakeAssistantMessage],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes sendmessageto_agent instead of delegate_to_execution", async () => {
    const { createChatAgent } = await import("./factory");
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const agent = createChatAgent(storage, "telegram-chat:test", testBindings, {
      sessionKey: testSessionKey,
    });

    await drainRun(await agent.session(testSessionKey).send("delegate"));

    const tools = lastGenerateTextTools();
    expect(Object.keys(tools).sort()).toEqual(["sendmessageto_agent"]);
    expect(tools).not.toHaveProperty("delegate_to_execution");
  });

  it("exposes sendmessageto_agent as a background-only tool schema", async () => {
    const { createChatAgent } = await import("./factory");
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const agent = createChatAgent(storage, "telegram-chat:test", testBindings, {
      sessionKey: testSessionKey,
    });

    await drainRun(await agent.session(testSessionKey).send("delegate"));

    expect(toolJsonSchema(lastGenerateTextTools().sendmessageto_agent)).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          prompt: expect.any(Object),
        }),
        required: ["prompt"],
      })
    );
    expect(
      JSON.stringify(
        toolJsonSchema(lastGenerateTextTools().sendmessageto_agent)
      )
    ).not.toContain("run_in_background");
  });

  it("exposes telegram UX tools when telegramUx context is provided", async () => {
    const { createChatAgent } = await import("./factory");
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const agent = createChatAgent(storage, "telegram-chat:test", testBindings, {
      sessionKey: testSessionKey,
      telegramUx: {
        messageId: "msg-1",
        thread: {
          id: "thread-1",
          addReaction: async () => undefined,
          post: async () => undefined,
          startTyping: async () => undefined,
        },
      },
    });

    await drainRun(await agent.session(testSessionKey).send("hello"));

    const tools = lastGenerateTextTools();
    expect(Object.keys(tools).sort()).toEqual([
      "display_draft",
      "reactto_message",
      "sendmessageto_agent",
    ]);
  });

  it("exposes web tools on the execution agent only", async () => {
    const { createExecutionAgent } = await import("./factory");
    const { createInMemoryExecutionHost } = await import(
      "@minpeter/pss-runtime/execution/memory"
    );
    const agent = createExecutionAgent(
      createInMemoryExecutionHost(),
      testBindings
    );

    await drainRun(await agent.send("search typescript release notes"));

    const tools = lastGenerateTextTools();
    expect(Object.keys(tools).sort()).toEqual(["web_fetch", "web_search"]);
  });

  it("omits telegram UX tools when telegramUx context is absent", async () => {
    const { createChatAgent } = await import("./factory");
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const agent = createChatAgent(storage, "telegram-chat:test", testBindings, {
      sessionKey: testSessionKey,
    });

    await drainRun(await agent.session(testSessionKey).send("hello"));

    const tools = lastGenerateTextTools();
    expect(tools).not.toHaveProperty("display_draft");
    expect(tools).not.toHaveProperty("reactto_message");
  });

  it("omits sendmessageto_agent when sessionKey is absent", async () => {
    const { createChatAgent } = await import("./factory");
    const storage = new InMemoryCloudflareDurableObjectStorage();
    const agent = createChatAgent(storage, "telegram-chat:test", testBindings);

    await drainRun(await agent.send("hello"));

    const tools = lastGenerateTextTools();
    expect(tools).not.toHaveProperty("sendmessageto_agent");
  });
});