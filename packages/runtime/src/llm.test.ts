import type { LanguageModel, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const duplicatePluginToolPattern = /duplicate tool "duplicate"/i;

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

async function loadPlugins() {
  const { definePlugin } = await import("./plugins");
  return { definePlugin };
}

async function drainRun(run: { events(): AsyncIterable<unknown> }) {
  for await (const _event of run.events()) {
    // Drain the run so model calls complete before assertions.
  }
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
    const injectedTools = { injected: createNoopTool() } satisfies ToolSet;
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

  it("passes configured toolChoice to generateText", async () => {
    const createLlm = await loadCreateLlm();
    const signal = new AbortController().signal;
    const history = [{ role: "user" as const, content: "hello" }];
    const llm = createLlm({
      model: fakeModel,
      toolChoice: "required",
    });

    await expect(llm({ history, signal })).resolves.toEqual([
      assistantMessage("DONE"),
    ]);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolChoice: "required",
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
    const injectedTools = { injected: createNoopTool() } satisfies ToolSet;
    const agent = await Agent.create({
      model: fakeModel,
      tools: injectedTools,
    });

    await drainRun(await agent.send(userText("use injected tools")));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
        tools: injectedTools,
      })
    );
  });

  it("passes AgentOptions toolChoice into createLlm/generateText", async () => {
    const Agent = await loadAgent();
    const agent = await Agent.create({
      model: fakeModel,
      toolChoice: "required",
    });

    await drainRun(await agent.send(userText("force tool choice")));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
        toolChoice: "required",
      })
    );
  });

  it("passes plugin tools into createLlm/generateText", async () => {
    const Agent = await loadAgent();
    const { definePlugin } = await loadPlugins();
    const callerTools = { caller: createNoopTool() } satisfies ToolSet;
    const pluginTools = { plugin: createNoopTool() } satisfies ToolSet;
    const agent = await Agent.create({
      model: fakeModel,
      plugins: [
        definePlugin({
          name: "tool-plugin",
          setup(host) {
            host.registerTools(pluginTools);
          },
        }),
      ],
      tools: callerTools,
    });

    await drainRun(await agent.send(userText("use plugin tools")));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: fakeModel,
        tools: {
          ...callerTools,
          ...pluginTools,
        },
      })
    );
  });

  it("rejects duplicate plugin tool names before model calls", async () => {
    const Agent = await loadAgent();
    const { definePlugin } = await loadPlugins();
    const duplicatedTools = { duplicate: createNoopTool() } satisfies ToolSet;

    await expect(
      Agent.create({
        model: fakeModel,
        plugins: [
          definePlugin({
            name: "duplicate-tool-plugin",
            setup(host) {
              host.registerTools(duplicatedTools);
            },
          }),
        ],
        tools: duplicatedTools,
      })
    ).rejects.toThrow(duplicatePluginToolPattern);

    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("does not attach product tools by default", async () => {
    const Agent = await loadAgent();
    const agent = await Agent.create({ model: fakeModel });

    await drainRun(await agent.send(userText("run without product tools")));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: undefined,
      })
    );
  });
});
