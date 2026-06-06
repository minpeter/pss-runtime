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
import { createBackgroundOutputTool } from "./subagent-job-output";
import type { SubagentJob } from "./subagent-types";
import { assistantMessage, userText } from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("subagent background cleanup", () => {
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

  it("background_output evicts completed child task sessions", async () => {
    const Agent = await loadAgent();
    const childHistories: unknown[] = [];
    const researcher = new Agent({
      description: "Researches facts.",
      llm: ({ history }) => {
        childHistories.push(history);
        return Promise.resolve([assistantMessage("CHILD DONE")]);
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
        sessionKey: "cleanup-task",
      },
      toolExecutionOptions()
    )) as { task_id: string };
    await executableTool(tools, "background_output").execute?.(
      { block: true, task_id: launch.task_id },
      toolExecutionOptions()
    );
    await executableTool(tools, "delegate_to_researcher").execute?.(
      { prompt: "fresh task", sessionKey: "cleanup-task" },
      toolExecutionOptions()
    );

    expect(JSON.stringify(childHistories.at(-1))).toContain("fresh task");
    expect(JSON.stringify(childHistories.at(-1))).not.toContain(
      "research this"
    );
  });

  it("background_output still returns results when cleanup fails", async () => {
    const jobs = new Map<string, SubagentJob>();
    let failCleanup = true;
    jobs.set("bg_done", {
      abort: () => undefined,
      cleanup: () => {
        if (failCleanup) {
          failCleanup = false;
          return Promise.reject(new Error("cleanup failed"));
        }

        return Promise.resolve();
      },
      id: "bg_done",
      promise: Promise.resolve(),
      result: {
        eventCount: 1,
        result: "completed",
        run_in_background: false,
        subagent: "researcher",
        text: "done",
      },
      sessionKey: "child-session",
      status: "completed",
      subagent: "researcher",
    });

    const output = await createBackgroundOutputTool(jobs).execute?.(
      { task_id: "bg_done" },
      {
        abortSignal: new AbortController().signal,
        context: {},
        messages: [],
        toolCallId: "call-1",
      }
    );

    expect(output).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({ text: "done" }),
        status: "completed",
        task_id: "bg_done",
      })
    );
    expect(jobs.has("bg_done")).toBe(true);

    await createBackgroundOutputTool(jobs).execute?.(
      { task_id: "bg_done" },
      {
        abortSignal: new AbortController().signal,
        context: {},
        messages: [],
        toolCallId: "call-2",
      }
    );

    expect(jobs.has("bg_done")).toBe(false);
  });
});
