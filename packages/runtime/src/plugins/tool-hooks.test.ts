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
const fatalPolicyPattern = /fatal policy/;

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

function createToolExecutionOptions(
  toolCallId = "tool-call-1"
): ToolExecutionOptions<unknown> {
  return {
    abortSignal: new AbortController().signal,
    context: undefined,
    messages: [{ content: "tool prompt", role: "user" }],
    toolCallId,
  };
}

function executeGeneratedTool(
  toolName: string,
  input: unknown,
  toolCallId?: string
): Promise<unknown> {
  const selectedTool = readGeneratedTools()[toolName];
  if (!selectedTool || typeof selectedTool.execute !== "function") {
    throw new Error(`expected generated tool ${toolName} to be executable`);
  }

  return Promise.resolve(
    selectedTool.execute(input, createToolExecutionOptions(toolCallId))
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

describe("plugin tool hooks", () => {
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

  it("runs tool.call modify and tool.result replacement around runtime-owned tools", async () => {
    const { Agent, definePlugin } = await loadAgentAndPlugins();
    const trace: string[] = [];
    let executedInput: unknown;
    const tools = {
      inspected: createRecordingTool((input) => {
        trace.push("execute");
        executedInput = input;
        return { seen: input };
      }),
    } satisfies ToolSet;
    const agent = await Agent.create({
      model: fakeModel,
      plugins: [
        definePlugin({
          name: "tool-policy",
          setup(host) {
            host.on("tool.call", ({ input, tool, toolCallId }) => {
              trace.push(`call:${tool}:${toolCallId}`);
              return { action: "modify", input: { changed: input } };
            });
            host.on("tool.result", ({ output, status, tool }) => {
              trace.push(`result:${tool}:${status}`);
              return { output: { wrapped: output }, status: "done" };
            });
          },
        }),
      ],
      tools,
    });

    await drainRun(await agent.send(userText("use inspected tool")));
    const output = await executeGeneratedTool(
      "inspected",
      { original: true },
      "call-modify"
    );

    expect(executedInput).toEqual({ changed: { original: true } });
    expect(output).toEqual({
      wrapped: { seen: { changed: { original: true } } },
    });
    expect(trace).toEqual([
      "call:inspected:call-modify",
      "execute",
      "result:inspected:done",
    ]);
  });

  it("supports terminal tool.call decisions", async () => {
    const { Agent, definePlugin } = await loadAgentAndPlugins();
    const executedInputs: unknown[] = [];
    const tools = {
      guarded: createRecordingTool((input) => {
        executedInputs.push(input);
        return { allowed: input };
      }),
    } satisfies ToolSet;
    const agent = await Agent.create({
      model: fakeModel,
      plugins: [
        definePlugin({
          name: "terminal-tool-policy",
          setup(host) {
            host.on("tool.call", ({ input }) => {
              if (!isRecord(input)) {
                return { action: "allow" };
              }
              if (input.mode === "reject") {
                return {
                  action: "reject-and-continue",
                  message: "blocked by policy",
                };
              }
              if (input.mode === "synthesize") {
                return {
                  action: "synthesize",
                  result: { exitCode: 0, output: { synthetic: true } },
                };
              }
              if (input.mode === "error") {
                return { action: "error", message: "fatal policy" };
              }
              return { action: "allow" };
            });
          },
        }),
      ],
      tools,
    });

    await drainRun(await agent.send(userText("use guarded tool")));

    await expect(executeGeneratedTool("guarded", {})).resolves.toEqual({
      allowed: {},
    });
    await expect(
      executeGeneratedTool("guarded", { mode: "reject" })
    ).resolves.toEqual({
      message: "blocked by policy",
      rejected: true,
    });
    await expect(
      executeGeneratedTool("guarded", { mode: "synthesize" })
    ).resolves.toEqual({ synthetic: true });
    await expect(
      executeGeneratedTool("guarded", { mode: "error" })
    ).rejects.toThrow(fatalPolicyPattern);
    expect(executedInputs).toEqual([{}]);
  });
});
