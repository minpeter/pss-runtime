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
import {
  assistantMessage,
  createDeferred,
  researcherSubagent,
  userText,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();
const activeJobStatusPattern = /pending|running/;
const backgroundTaskIdPattern = /^bg_/;
const backgroundTaskIdErrorPattern =
  /expects a background task_id starting with bg_/;

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
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: async () => [],
        }),
      ],
    });

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
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: ({ signal }) =>
            new Promise((_, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new Error("child aborted")),
                { once: true }
              );
            }),
        }),
      ],
    });

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
  it("background_output can block until completion", async () => {
    const Agent = await loadAgent();
    const childGate = createDeferred();
    const agent = new Agent({
      model: fakeModel,
      subagents: [
        researcherSubagent({
          model: async () => {
            await childGate.promise;
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
      executableTool(lastGenerateTextTools(), "background_output").execute?.(
        { task_id: "parent:default:subagent:researcher" },
        toolExecutionOptions()
      )
    ).rejects.toThrow(backgroundTaskIdErrorPattern);
  });
});
