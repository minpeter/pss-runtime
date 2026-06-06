import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainRun,
  executableTool,
  fakeModel,
  getGenerateTextMock,
  lastGenerateTextTools,
  loadAgent,
  toolExecutionOptions,
} from "./llm-test-utils";
import { assistantMessage, createDeferred, userText } from "./test-fixtures";

const activeJobStatusPattern = /pending|running/;
const backgroundTaskIdPattern = /^bg_/;
const backgroundTaskIdErrorPattern =
  /expects a background task_id starting with bg_/;
const unknownBackgroundTaskPattern = /Unknown background subagent task/;
const generateTextMock = getGenerateTextMock();

describe("subagent background tools", () => {
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
          task_id: expect.any(Object),
          timeout: expect.any(Object),
        }),
        required: ["task_id"],
      })
    );
    expect(JSON.stringify(schema)).not.toContain("full_session");
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

    const output = await executableTool(
      lastGenerateTextTools(),
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research this", run_in_background: true },
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
    const launch = (await executableTool(
      tools,
      "delegate_to_researcher"
    ).execute?.(
      { prompt: "research this", run_in_background: true },
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

  it("background_output forgets completed jobs after retrieval", async () => {
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
    ).rejects.toThrow(unknownBackgroundTaskPattern);
  });

  it("background_output can block until completion", async () => {
    const Agent = await loadAgent();
    const childGate = createDeferred();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => {
        await childGate.promise;
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
      { prompt: "research this", run_in_background: true },
      toolExecutionOptions()
    )) as { task_id: string };
    const outputPromise = executableTool(tools, "background_output").execute?.(
      { block: true, task_id: launch.task_id, timeout: 1000 },
      toolExecutionOptions()
    );

    childGate.resolve();

    await expect(outputPromise).resolves.toEqual(
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
});
