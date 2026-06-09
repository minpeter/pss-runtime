import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost } from "./execution/types";
import {
  drainRun,
  executableTool,
  fakeModel,
  getGenerateTextMock,
  lastGenerateTextTools,
  loadAgent,
  toolExecutionOptions,
} from "./llm-test-utils";
import { resumeBackgroundTask } from "./subagent-background-test-support";
import {
  assistantMessage,
  createDeferred,
  researcherSubagent,
  userText,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("subagent background cancel tool", () => {
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

  it("background_cancel aborts active job", async () => {
    const Agent = await loadAgent();
    const childGate = new Promise<void>(() => undefined);
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: async () => {
            await childGate;
            return [assistantMessage("CHILD DONE")];
          },
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    const launch = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research this", run_in_background: true },
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

  it("background_cancel cancels durable child runs when the local job map is empty", async () => {
    const Agent = await loadAgent();
    const host = {
      ...createInMemoryExecutionHost(),
      capabilities: { backgroundSubagents: "durable" },
    } satisfies ExecutionHost;
    const taskId = "bg_durable_cancel";
    await host.store.runs.create({
      checkpointVersion: 0,
      kind: "background-subagent",
      parentRunId: "parent",
      publicTaskId: taskId,
      rootRunId: "parent",
      runId: `background:${taskId}`,
      sessionKey:
        "parent:agent:cancel-parent:session:default:generation:0:default:subagent:researcher",
      status: "running",
    });
    const agent = new Agent({
      host,
      model: fakeModel,
      namespace: "cancel-parent",
      subagents: [
        researcherSubagent({
          host,
          model: () => Promise.resolve([assistantMessage("CHILD DONE")]),
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));

    expect(
      await executableTool(
        lastGenerateTextTools(),
        "background_cancel"
      ).execute?.({ task_id: taskId }, toolExecutionOptions())
    ).toEqual({
      status: "cancelled",
      task_id: taskId,
    });
    await expect(
      host.store.runs.get(`background:${taskId}`)
    ).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("background_cancel returns the durable terminal state for a stale local job", async () => {
    const Agent = await loadAgent();
    const host = {
      ...createInMemoryExecutionHost(),
      capabilities: { backgroundSubagents: "durable" as const },
    } satisfies ExecutionHost;
    const childGate = createDeferred();
    const agent = new Agent({
      host,
      model: fakeModel,
      namespace: "cancel-stale-parent",
      subagents: [
        researcherSubagent({
          host,
          model: async () => {
            await childGate.promise;
            return [assistantMessage("STALE CHILD")];
          },
        }),
      ],
    });

    await drainRun(await agent.send(userText("delegate")));
    const tools = lastGenerateTextTools();
    const launch = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research this", run_in_background: true },
      toolExecutionOptions()
    )) as { task_id: string };
    const record = await host.store.runs.get(`background:${launch.task_id}`);
    if (!record) {
      throw new Error("Expected background run record.");
    }
    await host.store.runs.update({
      ...record,
      output: {
        eventCount: 1,
        result: "completed",
        run_in_background: false,
        subagent: "researcher",
        text: "ALREADY DONE",
      },
      status: "completed",
    });

    await expect(
      executableTool(tools, "background_cancel").execute?.(
        { task_id: launch.task_id },
        toolExecutionOptions()
      )
    ).resolves.toEqual({
      status: "completed",
      task_id: launch.task_id,
    });
    await expect(
      host.store.runs.get(`background:${launch.task_id}`)
    ).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("durable background tools reject task ids owned by another parent namespace", async () => {
    const Agent = await loadAgent();
    const host = {
      ...createInMemoryExecutionHost(),
      capabilities: { backgroundSubagents: "durable" as const },
    } satisfies ExecutionHost;
    const childGate = createDeferred();
    const researcher = researcherSubagent({
      host,
      model: async () => {
        await childGate.promise;
        return [assistantMessage("CHILD DONE")];
      },
      namespace: "owner-researcher",
    });
    const owner = new Agent({
      host,
      model: fakeModel,
      namespace: "owner-parent",
      subagents: [researcher],
    });
    const stranger = new Agent({
      host,
      model: fakeModel,
      namespace: "stranger-parent",
      subagents: [researcher],
    });

    await drainRun(await owner.session("parent").send(userText("delegate")));
    const ownerTools = lastGenerateTextTools();
    const launch = (await executableTool(
      ownerTools,
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research this", run_in_background: true },
      toolExecutionOptions()
    )) as { task_id: string };

    await drainRun(await stranger.session("parent").send(userText("delegate")));
    const strangerTools = lastGenerateTextTools();

    await expect(
      executableTool(strangerTools, "background_output").execute?.(
        { task_id: launch.task_id },
        toolExecutionOptions()
      )
    ).rejects.toThrow(`Unknown background subagent task ${launch.task_id}.`);
    await expect(
      executableTool(strangerTools, "background_cancel").execute?.(
        { task_id: launch.task_id },
        toolExecutionOptions()
      )
    ).rejects.toThrow(`Unknown background subagent task ${launch.task_id}.`);
    await expect(
      host.store.runs.get(`background:${launch.task_id}`)
    ).resolves.toEqual(expect.objectContaining({ status: "queued" }));

    childGate.resolve();
    await drainRun(await resumeBackgroundTask(owner, launch.task_id));
    await expect(
      executableTool(ownerTools, "background_output").execute?.(
        { block: true, task_id: launch.task_id },
        toolExecutionOptions()
      )
    ).resolves.toEqual(expect.objectContaining({ status: "completed" }));
  });
});
