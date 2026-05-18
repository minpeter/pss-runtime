import type { LanguageModel } from "ai";
import { jsonSchema, tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentTools, tools } from "../tools";
import { Agent } from "./agent";
import { createLlm } from "./llm";
import { assistantMessage, userText } from "./test-fixtures";

const generateTextMock = vi.hoisted(() => vi.fn());

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

describe("createLlm", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
  });

  it("passes injected tools to generateText", async () => {
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
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("DONE")],
    });
  });

  it("passes injected AgentOptions tools into createLlm/generateText", async () => {
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

  it("defaults new Agent() to the shared web tool map", async () => {
    const session = new Agent().createSession();

    await session.submit(userText("use default tools"));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools,
      })
    );
    expect(Object.keys(tools).sort()).toEqual(["web_fetch", "web_search"]);
  });
});
