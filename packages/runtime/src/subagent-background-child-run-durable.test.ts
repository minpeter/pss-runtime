import type { Tool } from "ai";
import {
  describe,
  expect,
  it } from "vitest";
import { createInMemoryExecutionHost } from "./execution/memory";
import {
  drainRun,
  executableTool,
  fakeModel,
  lastGenerateTextTools,
  loadAgent,
  toolExecutionOptions,
  } from "./llm-test-utils";
import type { AgentEvent } from "./session/events";
import type { AgentRun } from "./session/run";
import { startBackgroundJob } from "./subagent-jobs";
import type { RuntimeInputSink,
  Subagent,
  SubagentJob } from "./subagent-types";
import { assistantMessage,
  userText,
  researcherSubagent,
} from "./test-fixtures";

describe("durable background subagent child runs", () => {
  it("queued durable background launches replay without rerunning child work", async () => {
    const Agent = await loadAgent();
    const host = {
      ...createInMemoryExecutionHost(),
      capabilities: { backgroundSubagents: "durable" as const },
    };
    let childCalls = 0;
    const makeAgent = () => {
      const researcher = researcherSubagent({
        host,
        model: () => {
          childCalls += 1;
          return Promise.resolve([assistantMessage("CHILD DONE")]);
        },
        namespace: "qa-active-researcher",
      });      return new Agent({
        host,
        model: fakeModel,
        namespace: "qa-active-parent",
        subagents: [researcher],
      });
    };
    const options = {
      ...toolExecutionOptions(),
      toolCallId: "call_bg_active_replay",
    };

    const agent = makeAgent();
    await drainRun(await agent.session("parent").send(userText("delegate")));
    const tools = lastGenerateTextTools();
    const first = await executeTool(
      executableTool(tools, "delegate_to_researcher"),
      { prompt: "research this", run_in_background: true },
      options
    );
    expect(childCalls).toBe(0);

    const replayedAgent = makeAgent();
    await drainRun(
      await replayedAgent.session("parent").send(userText("delegate"))
    );
    const replayed = await executeTool(
      executableTool(lastGenerateTextTools(), "delegate_to_researcher"),
      { prompt: "research this", run_in_background: true },
      options
    );

    expect(replayed).toMatchObject({
      status: "pending",
      task_id: first.task_id,
    });
    expect(childCalls).toBe(0);
  });

  it("terminal durable background launches replay without rerunning child work", async () => {
    const Agent = await loadAgent();
    const host = {
      ...createInMemoryExecutionHost(),
      capabilities: { backgroundSubagents: "durable" as const },
    };
    let childCalls = 0;
    const makeAgent = () => {
      const researcher = researcherSubagent({
        host,
        model: () => {
          childCalls += 1;
          return Promise.resolve([assistantMessage("CHILD DONE")]);
        },
        namespace: "qa-researcher",
      });      return new Agent({
        host,
        model: fakeModel,
        namespace: "qa-parent",
        subagents: [researcher],
      });
    };
    const options = {
      ...toolExecutionOptions(),
      toolCallId: "call_bg_terminal_replay",
    };

    const agent = makeAgent();
    await drainRun(await agent.session("parent").send(userText("delegate")));
    const tools = lastGenerateTextTools();
    const first = await executeTool(
      executableTool(tools, "delegate_to_researcher"),
      { prompt: "research this", run_in_background: true },
      options
    );
    const resumedRun = await agent.resume(`background:${first.task_id}`);
    if (resumedRun) {
      await drainRun(resumedRun);
    }

    const replayedAgent = makeAgent();
    await drainRun(
      await replayedAgent.session("parent").send(userText("delegate"))
    );
    const replayedTools = lastGenerateTextTools();
    const replayed = await executeTool(
      executableTool(replayedTools, "delegate_to_researcher"),
      { prompt: "research this", run_in_background: true },
      options
    );
    const output = await executeTool(
      executableTool(replayedTools, "background_output"),
      { task_id: first.task_id },
      toolExecutionOptions()
    );

    expect(replayed).toMatchObject({
      status: "completed",
      task_id: first.task_id,
    });
    expect(output).toMatchObject({
      result: {
        result: "completed",
        subagent: "researcher",
        text: "CHILD DONE",
      },
      status: "completed",
      task_id: first.task_id,
    });
    expect(childCalls).toBe(1);
  });

  it("pre-aborted background launches do not persist durable child runs", async () => {
    const host = createInMemoryExecutionHost();
    const jobs = new Map<string, SubagentJob>();
    const abortController = new AbortController();
    abortController.abort();
    const subagent: Subagent = {
      name: "researcher",
      session: () => ({
        delete: async () => undefined,
        interrupt: () => undefined,
        send: () => Promise.reject(new Error("should not run")),
      }),
    };

    const launch = await startBackgroundJob({
      abortSignal: abortController.signal,
      delegateToolCallId: "call_aborted_bg",
      executionHost: host,
      jobs,
      parentSession: parentSession(),
      prompt: { text: "research", type: "user-text" },
      registerCleanup: () => () => undefined,
      sessionKey: "parent:default:subagent:researcher",
      subagent,
    });

    expect(launch).toMatchObject({
      status: "cancelled",
      subagent: "researcher",
    });
    expect(jobs.size).toBe(0);
    await expect(
      host.store.runs.get(`background:${launch.task_id}`)
    ).resolves.toBeNull();
  });
});

async function executeTool(
  candidate: Tool,
  input: unknown,
  options: ReturnType<typeof toolExecutionOptions>
): Promise<{
  readonly result?: unknown;
  readonly status?: unknown;
  readonly task_id: string;
}> {
  const output = await candidate.execute?.(input, options);
  if (
    typeof output === "object" &&
    output !== null &&
    "task_id" in output &&
    typeof output.task_id === "string"
  ) {
    return output as {
      readonly result?: unknown;
      readonly status?: unknown;
      readonly task_id: string;
    };
  }

  throw new Error("Expected background tool output with task_id.");
}

function parentSession(): RuntimeInputSink {
  return {
    emitObserverEvent: () => Promise.resolve(),
    enqueueRuntimeInput: () => undefined,
    notify: () => Promise.resolve(emptyRun()),
  };
}

function emptyRun(): AgentRun {
  const events = () => ({
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () =>
      Promise.resolve({
        done: true as const,
        value: undefined as never as AgentEvent,
      }),
  });
  return { events };
}
