import type { ToolSet } from "ai";
import {
  beforeEach,
  describe,
  expect,
  it,
  vi } from "vitest";
import type { Agent } from "./agent";
import type { SubagentDefinition } from "./subagent-definition";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost,
  ResumeSessionOptions } from "./execution/types";
import {
  drainRun,
  executableTool,
  fakeModel,
  getGenerateTextMock,
  lastGenerateTextTools,
  loadAgent,
  toolExecutionOptions,
  } from "./llm-test-utils";
import type { AgentRun } from "./session/run";
import { assistantMessage,
  userText,
  researcherSubagent,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();
const notificationRunPattern = /^notification:/;
const parentRunPattern = /^agent:durable-parent:session:parent:generation:0$/;

interface DurableSchedulerHost extends ExecutionHost {
  readonly enqueuedRunIds: string[];
  readonly resumedSessions: {
    readonly options?: ResumeSessionOptions;
    readonly sessionKey: string;
  }[];
}

interface ResumeAgent {
  resume(runId: string): Promise<AgentRun | null>;
}

describe("durable background subagent scheduling", () => {
  beforeEach(() => {
    vi.resetModules();
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      responseMessages: [assistantMessage("PARENT DONE")],
    });
  });

  it("enqueues durable background child runs without executing child work in the launch invocation", async () => {
    const AgentClass = await loadAgent();
    const host = createDurableSchedulerHost();
    let childCalls = 0;
    const researcher = researcherSubagent({
      host,
      model: () => {
        childCalls += 1;
        return Promise.resolve([assistantMessage("CHILD DONE")]);
      },
      namespace: "durable-scheduled-researcher",
    });
    const parent = createParentAgent(AgentClass, host, researcher);
    let launch: { readonly task_id: string } | undefined;
    generateTextMock.mockImplementationOnce(async (options: unknown) => {
      launch = await executeBackgroundDelegate(toolsFromOptions(options));
      return { responseMessages: [assistantMessage("PARENT DONE")] };
    });

    await drainRun(await parent.session("parent").send(userText("delegate")));
    await Promise.resolve();

    const launched = requireLaunch(launch);
    const runId = `background:${launched.task_id}`;
    await expect(host.store.runs.get(runId)).resolves.toMatchObject({
      kind: "background-subagent",
      parentRunId: expect.stringMatching(parentRunPattern),
      publicTaskId: launched.task_id,
      status: "queued",
    });
    expect(host.enqueuedRunIds).toEqual([runId]);
    expect(childCalls).toBe(0);
  });

  it("parent delete cancels live-path queued durable background child runs", async () => {
    const AgentClass = await loadAgent();
    const host = createDurableSchedulerHost();
    const researcher = researcherSubagent({
      host,
      model: async () => [assistantMessage("CHILD DONE")],
      namespace: "durable-delete-researcher",
    });
    const parent = createParentAgent(AgentClass, host, researcher);
    let launch: { readonly task_id: string } | undefined;
    generateTextMock.mockImplementationOnce(async (options: unknown) => {
      launch = await executeBackgroundDelegate(toolsFromOptions(options));
      return { responseMessages: [assistantMessage("PARENT DONE")] };
    });

    await drainRun(await parent.session("parent").send(userText("delegate")));
    const launched = requireLaunch(launch);
    const runId = `background:${launched.task_id}`;

    await parent.session("parent").delete();

    await expect(host.store.runs.get(runId)).resolves.toMatchObject({
      parentRunId: expect.stringMatching(parentRunPattern),
      status: "cancelled",
    });
  });

  it("resumes a queued durable background child run in a later invocation", async () => {
    const AgentClass = await loadAgent();
    const host = createDurableSchedulerHost();
    let childCalls = 0;
    const makeResearcher = () =>

      researcherSubagent({
        host,
        model: () => {
          childCalls += 1;
          return Promise.resolve([assistantMessage("CHILD DONE")]);
        },
        namespace: "durable-resume-researcher",
      });
    const parent = createParentAgent(AgentClass, host, makeResearcher());
    let launch: { readonly task_id: string } | undefined;
    generateTextMock.mockImplementationOnce(async (options: unknown) => {
      launch = await executeBackgroundDelegate(toolsFromOptions(options));
      return { responseMessages: [assistantMessage("PARENT DONE")] };
    });

    await drainRun(await parent.session("parent").send(userText("delegate")));
    const launched = requireLaunch(launch);
    const runId = `background:${launched.task_id}`;
    const resumedParent = createParentAgent(AgentClass, host, makeResearcher());

    expectResumeSurface(resumedParent);
    const resumedRun = await resumedParent.resume(runId);
    expect(resumedRun).not.toBeNull();
    if (resumedRun) {
      await drainRun(resumedRun);
    }

    expect(childCalls).toBe(1);
    await expect(host.store.runs.get(runId)).resolves.toMatchObject({
      output: expect.objectContaining({
        result: "completed",
        subagent: "researcher",
        text: "CHILD DONE",
      }),
      status: "completed",
    });
    expect(host.resumedSessions).toEqual([
      {
        options: expect.objectContaining({
          idempotencyKey: `background-complete:parent:${launched.task_id}`,
          runId: expect.stringMatching(notificationRunPattern),
        }),
        sessionKey: "parent",
      },
    ]);
  });
});

async function executeBackgroundDelegate(
  tools: ToolSet = lastGenerateTextTools()
): Promise<{ readonly task_id: string }> {
  const delegate = executableTool(tools, "delegate_to_researcher");
  const output = await delegate.execute?.(
    { prompt: "research this", run_in_background: true },
    {
      ...toolExecutionOptions(),
      toolCallId: "call_durable_schedule",
    }
  );
  return assertBackgroundLaunch(output);
}

function requireLaunch(launch: { readonly task_id: string } | undefined): {
  readonly task_id: string;
} {
  if (launch) {
    return launch;
  }

  throw new Error("Expected model mock to launch background work.");
}

function assertBackgroundLaunch(value: unknown): { readonly task_id: string } {
  if (
    typeof value === "object" &&
    value !== null &&
    "task_id" in value &&
    typeof value.task_id === "string"
  ) {
    return { task_id: value.task_id };
  }

  throw new Error("Expected background launch output with task_id.");
}

function createParentAgent(
  AgentClass: typeof Agent,
  host: ExecutionHost,
  researcher: SubagentDefinition
): Agent {
  return new AgentClass({
    host,
    model: fakeModel,
    namespace: "durable-parent",
    subagents: [researcher],
  });
}

function createDurableSchedulerHost(): DurableSchedulerHost {
  const base = createInMemoryExecutionHost();
  const enqueuedRunIds: string[] = [];
  const resumedSessions: {
    readonly options?: ResumeSessionOptions;
    readonly sessionKey: string;
  }[] = [];
  return {
    ...base,
    capabilities: {
      ...base.capabilities,
      backgroundSubagents: "durable",
    },
    enqueuedRunIds,
    scheduler: {
      enqueueRun: async (runId, options) => {
        enqueuedRunIds.push(runId);
        await base.scheduler.enqueueRun(runId, options);
      },
      resumeSession: async (sessionKey, options) => {
        resumedSessions.push({ options, sessionKey });
        await base.scheduler.resumeSession(sessionKey, options);
      },
    },
    resumedSessions,
  };
}

function toolsFromOptions(options: unknown): ToolSet {
  if (
    typeof options === "object" &&
    options !== null &&
    "tools" in options &&
    isToolSet(options.tools)
  ) {
    return options.tools;
  }

  return {};
}

function isToolSet(value: unknown): value is ToolSet {
  return typeof value === "object" && value !== null;
}

function expectResumeSurface(
  agent: Agent
): asserts agent is Agent & ResumeAgent {
  const maybeResume =
    typeof agent === "object" && agent !== null && "resume" in agent
      ? agent.resume
      : undefined;
  expect(
    typeof maybeResume,
    "Agent must expose resume(runId) for host-scheduled durable runs"
  ).toBe("function");
}
