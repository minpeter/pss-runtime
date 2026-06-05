import type { LanguageModel, ToolExecutionOptions, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMessage, userText } from "../test-fixtures";

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

const createRecordingTool = (execute: (input: unknown) => unknown) =>
  tool({
    description: "Recording test tool.",
    execute,
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: true,
    }),
    outputSchema: jsonSchema({
      type: "object",
      properties: {},
      additionalProperties: true,
    }),
  });

async function loadAgentAndPlugins() {
  const [{ Agent }, { definePlugin }] = await Promise.all([
    import("../agent"),
    import("./index"),
  ]);
  return { Agent, definePlugin };
}

async function drainRun(run: { events(): AsyncIterable<unknown> }) {
  let drainedEvents = 0;
  for await (const _event of run.events()) {
    drainedEvents += 1;
  }
  return drainedEvents;
}

function createToolExecutionOptions(): ToolExecutionOptions<unknown> {
  return {
    abortSignal: new AbortController().signal,
    context: undefined,
    messages: [{ content: "tool prompt", role: "user" }],
    toolCallId: "tool-call-1",
  };
}

function executeGeneratedTool(
  toolName: string,
  input: unknown
): Promise<unknown> {
  const selectedTool = readGeneratedTools()[toolName];
  if (!selectedTool || typeof selectedTool.execute !== "function") {
    throw new Error(`expected generated tool ${toolName} to be executable`);
  }

  return Promise.resolve(
    selectedTool.execute(input, createToolExecutionOptions())
  );
}

function readGeneratedTools(): ToolSet {
  const options = generateTextMock.mock.calls.at(-1)?.[0];
  if (!(isRecord(options) && isToolSet(options.tools))) {
    throw new Error("expected generateText to receive a tool set");
  }

  return options.tools;
}

function isToolSet(value: unknown): value is ToolSet {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

describe("plugin tool result hooks", () => {
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

  it("lets tool.result replace done, error, and cancelled outputs", async () => {
    const { Agent, definePlugin } = await loadAgentAndPlugins();
    const tools = {
      replaceable: createRecordingTool((input) => {
        if (isRecord(input) && input.mode === "throw") {
          throw new Error("tool exploded");
        }
        return { base: input };
      }),
    } satisfies ToolSet;
    const agent = await Agent.create({
      model: fakeModel,
      plugins: [
        definePlugin({
          name: "tool-result-policy",
          setup(host) {
            host.on("tool.result", ({ input, status }) => {
              if (!isRecord(input)) {
                return;
              }
              if (status === "done" && input.mode === "replace") {
                return { output: { replaced: true }, status: "done" };
              }
              if (input.mode === "throw") {
                return {
                  error: "masked failure",
                  output: { recovered: true },
                  status: "error",
                };
              }
              if (input.mode === "cancel") {
                return { error: "cancelled by plugin", status: "cancelled" };
              }
            });
          },
        }),
      ],
      tools,
    });

    await drainRun(await agent.send(userText("use replaceable tool")));

    await expect(
      executeGeneratedTool("replaceable", { mode: "replace" })
    ).resolves.toEqual({ replaced: true });
    await expect(
      executeGeneratedTool("replaceable", { mode: "throw" })
    ).resolves.toEqual({ recovered: true });
    await expect(
      executeGeneratedTool("replaceable", { mode: "cancel" })
    ).resolves.toEqual({
      error: "cancelled by plugin",
      status: "cancelled",
    });
  });

  it("does not emit tool plugin events for custom llm mode", async () => {
    const { Agent, definePlugin } = await loadAgentAndPlugins();
    let toolCallEvents = 0;
    const agent = await Agent.create({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
      plugins: [
        definePlugin({
          name: "custom-llm-tool-events",
          setup(host) {
            host.on("tool.call", () => {
              toolCallEvents += 1;
            });
          },
        }),
      ],
    });

    await drainRun(await agent.send(userText("custom llm")));

    expect(toolCallEvents).toBe(0);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("keeps observe-only tool hook mutations out of execution results", async () => {
    const { Agent, definePlugin } = await loadAgentAndPlugins();
    let executedInput: unknown;
    const tools = {
      mutable: createRecordingTool((input) => {
        executedInput = input;
        return { nested: { value: "original" } };
      }),
    } satisfies ToolSet;
    const agent = await Agent.create({
      model: fakeModel,
      plugins: [
        definePlugin({
          name: "observe-only-isolation",
          setup(host) {
            host.on("tool.call", ({ input }) => {
              if (isRecord(input)) {
                input.nested = { value: "mutated-by-call" };
              }
            });
            host.on("tool.result", ({ output }) => {
              if (isRecord(output)) {
                output.nested = { value: "mutated-by-result" };
              }
            });
          },
        }),
      ],
      tools,
    });

    await drainRun(await agent.send(userText("use mutable tool")));
    const output = await executeGeneratedTool("mutable", {
      nested: { value: "original" },
    });

    expect(executedInput).toEqual({ nested: { value: "original" } });
    expect(output).toEqual({ nested: { value: "original" } });
  });
});
