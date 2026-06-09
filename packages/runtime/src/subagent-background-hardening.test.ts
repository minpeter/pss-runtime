import type { LanguageModel, Tool, ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "./session/events";
import {
  assistantMessage,
  createDeferred,
  notifyRuntimeInput,
  researcherSubagent,
  userText,
} from "./test-fixtures";

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
const messageLimitAttackKey = ["message", "limit"].join("_");

async function loadAgent() {
  const { Agent } = await import("./agent");
  return Agent;
}

async function collectRun(run: { events(): AsyncIterable<AgentEvent> }) {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}

async function drainRun(run: { events(): AsyncIterable<unknown> }) {
  let drained = 0;
  for await (const _event of run.events()) {
    drained += 1;
  }
  return drained;
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

function toolExecutionOptions(signal = new AbortController().signal) {
  return {
    abortSignal: signal,
    context: undefined,
    messages: [],
    toolCallId: "call-1",
  };
}

describe("subagent background hardening", () => {
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

  it("keeps background output compact even when raw event switches are provided", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: async () => [assistantMessage("CHILD DONE")],
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));
    const tools = lastGenerateTextTools();
    const schema = await (
      executableTool(tools, "background_output").inputSchema as {
        jsonSchema: unknown;
      }
    ).jsonSchema;
    const launch = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research this", run_in_background: true },
      toolExecutionOptions()
    )) as { task_id: string };
    const output = await executableTool(tools, "background_output").execute?.(
      {
        full_session: true,
        include_thinking: true,
        include_tool_results: true,
        [messageLimitAttackKey]: 0,
        block: true,
        task_id: launch.task_id,
      },
      toolExecutionOptions()
    );

    expect(JSON.stringify(schema)).not.toContain("full_session");
    expect(JSON.stringify(schema)).not.toContain("include_tool_results");
    expect(JSON.stringify(output)).not.toContain('"events"');
    expect(output).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({ text: "CHILD DONE" }),
        status: "completed",
      })
    );
  });

  it("uses background_cancel-specific invalid task id wording", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: async () => [],
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));

    await expect(
      executableTool(lastGenerateTextTools(), "background_cancel").execute?.(
        { task_id: "parent:default:subagent:researcher" },
        toolExecutionOptions()
      )
    ).rejects.toThrow("background_cancel expects a background task_id");
  });

  it("delivers late turn-start reminders to an already queued next turn", async () => {
    const Agent = await loadAgent();
    const firstParentStep = createDeferred();
    const releaseParent = createDeferred();
    const childCanFinish = createDeferred();
    let launchedTaskId = "";
    const researcher = researcherSubagent({
      model: async () => {
        await childCanFinish.promise;
        return [assistantMessage("CHILD DONE")];
      },
    });
    generateTextMock.mockImplementationOnce(
      async ({ tools }: { readonly tools?: ToolSet }) => {
        const launch = (await tools?.delegate_to_researcher?.execute?.(
          {
            description: "Research facts",
            prompt: "research this",
            run_in_background: true,
          },
          toolExecutionOptions()
        )) as { task_id: string };
        launchedTaskId = launch.task_id;
        firstParentStep.resolve();
        await releaseParent.promise;
        return { responseMessages: [assistantMessage("FIRST DONE")] };
      }
    );
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("SECOND DONE")],
    });
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });
    const firstRun = await agent.send(userText("first"));
    const firstEvents = collectRun(firstRun);
    await firstParentStep.promise;
    const secondEventsPromise = collectRun(
      await agent.send(userText("second"))
    );
    childCanFinish.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseParent.resolve();

    await firstEvents;
    const secondEvents = await secondEventsPromise;
    const reminder = secondEvents.find(
      (event) => event.type === "runtime-input"
    );

    expect(reminder).toEqual(
      expect.objectContaining({
        ...notifyRuntimeInput("", "turn-start"),
        input: {
          ...notifyRuntimeInput("", "turn-start").input,
          text: expect.stringContaining(
            `Use background_output({ task_id: "${launchedTaskId}" })`
          ),
        },
      })
    );
  });
});
