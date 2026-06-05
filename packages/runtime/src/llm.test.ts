import type { LanguageModel, Tool, ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./session/events";
import { assistantMessage, eventTypes, userText } from "./test-fixtures";

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
const activeJobStatusPattern = /pending|running/;
const backgroundTaskIdPattern = /^bg_/;
const backgroundTaskIdErrorPattern =
  /expects a background task_id starting with bg_/;

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

async function drainRun(run: { events(): AsyncIterable<unknown> }) {
  for await (const _event of run.events()) {
    // Drain the run so model calls complete before assertions.
  }
}

async function collectRun(run: { events(): AsyncIterable<AgentEvent> }) {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}

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

function toolExecutionOptions() {
  return {
    abortSignal: new AbortController().signal,
    context: undefined,
    messages: [],
    toolCallId: "call-1",
  };
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
    const agent = new Agent({
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
    const agent = new Agent({
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

  it("does not attach product tools by default", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({ model: fakeModel });

    await drainRun(await agent.send(userText("run without product tools")));

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: undefined,
      })
    );
  });

  it("passes generated delegate and background tools to model", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [],
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    expect(Object.keys(tools).sort()).toEqual([
      "background_cancel",
      "background_output",
      "delegate_to_researcher",
    ]);
    expect(executableTool(tools, "delegate_to_researcher")).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("Researches facts."),
      })
    );
  });

  it("defaults omitted run_in_background to blocking", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [assistantMessage("CHILD DONE")],
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    const delegate = executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    );
    const output = await delegate.execute?.(
      { prompt: "research this" },
      toolExecutionOptions()
    );

    expect(output).toEqual({
      eventCount: expect.any(Number),
      result: "completed",
      run_in_background: false,
      subagent: "researcher",
      text: "CHILD DONE",
    });
  });

  it("exposes background_output schema", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [],
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    const backgroundOutput = executableTool(
      lastGenerateTextTools(),
      "background_output"
    );
    const schema = await (
      backgroundOutput.inputSchema as { jsonSchema: unknown }
    ).jsonSchema;

    expect(schema).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          block: expect.any(Object),
          full_session: expect.any(Object),
          since_event_id: expect.any(Object),
          task_id: expect.any(Object),
          timeout: expect.any(Object),
        }),
        required: ["task_id"],
      })
    );
  });

  it("background delegation returns a job id before child completion", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("child aborted")),
            { once: true }
          );
        }),
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    const delegate = executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    );
    const output = await delegate.execute?.(
      {
        prompt: "research this",
        run_in_background: true,
      },
      toolExecutionOptions()
    );

    expect(output).toEqual(
      expect.objectContaining({
        run_in_background: true,
        status: expect.stringMatching(activeJobStatusPattern),
        subagent: "researcher",
        task_id: expect.stringMatching(backgroundTaskIdPattern),
      })
    );
  });

  it("background_output returns compact completed result", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [assistantMessage("CHILD DONE")],
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    const delegate = executableTool(tools, "delegate_to_researcher");
    const launch = (await delegate.execute?.(
      {
        prompt: "research this",
        run_in_background: true,
      },
      toolExecutionOptions()
    )) as { task_id: string };
    const output = await executableTool(tools, "background_output").execute?.(
      { block: true, task_id: launch.task_id },
      toolExecutionOptions()
    );

    expect(output).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          result: "completed",
          text: "CHILD DONE",
        }),
        status: "completed",
        task_id: launch.task_id,
      })
    );
  });

  it("background_output rejects session keys", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [],
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    await expect(
      executableTool(lastGenerateTextTools(), "background_output").execute?.(
        { task_id: "parent:default:subagent:researcher" },
        toolExecutionOptions()
      )
    ).rejects.toThrow(backgroundTaskIdErrorPattern);
  });

  it("background_cancel aborts active job", async () => {
    const Agent = await loadAgent();
    const childGate = new Promise<void>(() => undefined);
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => {
        await childGate;
        return [assistantMessage("CHILD DONE")];
      },
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    const launch = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      {
        prompt: "research this",
        run_in_background: true,
      },
      toolExecutionOptions()
    )) as { task_id: string };

    expect(
      await executableTool(tools, "background_cancel").execute?.(
        { task_id: launch.task_id },
        toolExecutionOptions()
      )
    ).toEqual({
      status: "cancelled",
      task_id: launch.task_id,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      await executableTool(tools, "background_output").execute?.(
        { block: true, task_id: launch.task_id, timeout: 50 },
        toolExecutionOptions()
      )
    ).toEqual(
      expect.objectContaining({
        result: undefined,
        status: "cancelled",
        task_id: launch.task_id,
      })
    );
  });

  it("injects compact background completion reminder", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [assistantMessage("CHILD DONE")],
      name: "researcher",
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    const launch = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      {
        description: "Research facts",
        prompt: "research this",
        run_in_background: true,
      },
      toolExecutionOptions()
    )) as { task_id: string };
    await executableTool(tools, "background_output").execute?.(
      { block: true, task_id: launch.task_id },
      toolExecutionOptions()
    );

    const events = await collectRun(await agent.send(userText("continue")));
    const reminder = events.find((event) => event.type === "runtime-input");

    expect(reminder).toEqual(
      expect.objectContaining({
        input: {
          text: expect.stringContaining(
            `Use background_output({ task_id: "${launch.task_id}" })`
          ),
          type: "user-text",
        },
        placement: "turn-start",
      })
    );
    expect(JSON.stringify(reminder)).not.toContain("CHILD DONE");
  });

  it("emits subagent job lifecycle events while executing generated tools", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [assistantMessage("CHILD DONE")],
      name: "researcher",
    });
    generateTextMock.mockImplementationOnce(
      async ({ tools }: { tools?: ToolSet }) => {
        await tools?.delegate_to_researcher?.execute?.(
          { prompt: "research this" },
          toolExecutionOptions()
        );
        return { responseMessages: [assistantMessage("PARENT DONE")] };
      }
    );
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    const events = await collectRun(await agent.send(userText("delegate")));

    expect(eventTypes(events)).toContain("subagent-job-start");
    expect(eventTypes(events)).toContain("subagent-job-end");
  });
});
