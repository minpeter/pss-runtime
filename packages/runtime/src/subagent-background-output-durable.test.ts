import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi } from "vitest";
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
import { assistantMessage,
  createDeferred,
  userText,
  researcherSubagent,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("durable subagent background output", () => {
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

  it("retains durable completed output after retrieval", async () => {
    const Agent = await loadAgent();
    const agent = new Agent({ model: fakeModel, subagents: [researcherSubagent({

      model: async () => [assistantMessage("CHILD DONE")],

    })] });

    await drainRun(await agent.send(userText("delegate")));

    const tools = lastGenerateTextTools();
    const launch = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research this", run_in_background: true },
      toolExecutionOptions()
    )) as { task_id: string };
    await executableTool(tools, "background_output").execute?.(
      { block: true, task_id: launch.task_id },
      toolExecutionOptions()
    );

    await expect(
      executableTool(tools, "background_output").execute?.(
        { task_id: launch.task_id },
        toolExecutionOptions()
      )
    ).resolves.toEqual(
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

  it("prefers durable output over a stale local job", async () => {
    const Agent = await loadAgent();
    const host = {
      ...createInMemoryExecutionHost(),
      capabilities: { backgroundSubagents: "durable" as const },
    } satisfies ExecutionHost;
    const childGate = createDeferred();
    const agent = new Agent({
      host,
      model: fakeModel,
      namespace: "output-stale-parent",
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
        text: "DURABLE DONE",
      },
      status: "completed",
    });

    await expect(
      executableTool(tools, "background_output").execute?.(
        { task_id: launch.task_id },
        toolExecutionOptions()
      )
    ).resolves.toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          result: "completed",
          text: "DURABLE DONE",
        }),
        status: "completed",
        task_id: launch.task_id,
      })
    );
  });
});
