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
import { cancelJob } from "./subagent-job-state";
import { startBackgroundJob } from "./subagent-jobs";
import type { RuntimeInputSink,
  Subagent,
  SubagentJob } from "./subagent-types";
import { assistantMessage,
  createDeferred,
  userText,
  researcherSubagent,
} from "./test-fixtures";

describe("background subagent child runs", () => {
  it("background launch can be replayed without duplicate child run", async () => {
    const Agent = await loadAgent();
    const childGate = createDeferred();
    const host = createInMemoryExecutionHost();
    let childCalls = 0;
    const agent = new Agent({
      host,
      model: fakeModel,
      subagents: [
        researcherSubagent({
          host,
          model: async () => {
            childCalls += 1;
            await childGate.promise;
            return [assistantMessage("CHILD DONE")];
          },
        }),
      ],
    });

    await drainRun(await agent.session("parent").send(userText("delegate")));
    const tools = lastGenerateTextTools();
    const delegate = executableTool(tools, "delegate_to_researcher");
    const options = {
      ...toolExecutionOptions(),
      toolCallId: "call_bg_dedupe",
    };

    const first = await executeTool(
      delegate,
      {
        prompt: "research this",
        run_in_background: true,
      },
      options
    );
    const second = await executeTool(
      delegate,
      {
        prompt: "research this",
        run_in_background: true,
      },
      options
    );

    expect(second).toMatchObject({
      task_id: first.task_id,
    });
    childGate.resolve();
    await executeTool(
      executableTool(tools, "background_output"),
      {
        block: true,
        task_id: first.task_id,
      },
      toolExecutionOptions()
    );

    expect(childCalls).toBe(1);
    await expect(
      host.store.runs.get(`background:${first.task_id}`)
    ).resolves.toMatchObject({
      kind: "background-subagent",
      publicTaskId: first.task_id,
      status: "completed",
    });
  });

  it("cancelled child completion does not enqueue stale notification", async () => {
    const host = createInMemoryExecutionHost();
    const jobs = new Map<string, SubagentJob>();
    const childGate = createDeferred();
    const notifications: string[] = [];
    const subagent: Subagent = {
      name: "researcher",
      session: () => ({
        delete: async () => undefined,
        interrupt: () => undefined,
        send: async () => delayedTextRun(childGate, "STALE CHILD DONE"),
      }),
    };

    const launch = await startBackgroundJob({
      abortSignal: new AbortController().signal,
      delegateToolCallId: "call_cancel_bg",
      executionHost: host,
      jobs,
      parentSession: parentSession(notifications),
      prompt: { text: "research", type: "user-text" },
      registerCleanup: () => () => undefined,
      sessionKey: "parent:default:subagent:researcher",
      subagent,
    });
    const job = mustGetJob(jobs, launch.task_id);

    cancelJob(job);
    childGate.resolve();
    await job.promise;

    expect(notifications).toEqual([]);
    await expect(
      host.store.runs.get(`background:${launch.task_id}`)
    ).resolves.toMatchObject({
      status: "cancelled",
    });
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

function delayedTextRun(
  gate: ReturnType<typeof createDeferred>,
  text: string
): AgentRun {
  async function* events(): AsyncIterable<AgentEvent> {
    await gate.promise;
    yield { text, type: "assistant-text" };
  }

  return { events };
}

function parentSession(notifications: string[]): RuntimeInputSink {
  return {
    emitObserverEvent: () => Promise.resolve(),
    enqueueRuntimeInput: () => undefined,
    notify: (input) => {
      if (input.type === "user-text" && typeof input.text === "string") {
        notifications.push(input.text);
      }
      return Promise.resolve(delayedTextRun(createDeferred(), "NOTIFIED"));
    },
  };
}

function mustGetJob(
  jobs: ReadonlyMap<string, SubagentJob>,
  taskId: string
): SubagentJob {
  const job = jobs.get(taskId);
  if (!job) {
    throw new Error(`Expected job ${taskId}.`);
  }
  return job;
}
