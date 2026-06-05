import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectRun,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
  toolExecutionOptions,
} from "./llm-test-utils";
import { assistantMessage, eventTypes, userText } from "./test-fixtures";

const generateTextMock = getGenerateTextMock();

describe("subagent job events", () => {
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
    const start = events.find((event) => event.type === "subagent-job-start");
    const end = events.find((event) => event.type === "subagent-job-end");

    expect(start).toEqual(
      expect.objectContaining({
        run_in_background: false,
        sessionKey: "parent:default:subagent:researcher",
        subagent: "researcher",
        type: "subagent-job-start",
      })
    );
    expect(end).toEqual(
      expect.objectContaining({
        eventCount: expect.any(Number),
        status: "completed",
        subagent: "researcher",
        type: "subagent-job-end",
      })
    );
    expect(eventTypes(events)).toContain("subagent-job-start");
    expect(eventTypes(events)).toContain("subagent-job-end");
  });

  it("emits compact background subagent job updates while collecting child events", async () => {
    const Agent = await loadAgent();
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => [assistantMessage("CHILD DONE")],
      name: "researcher",
    });
    generateTextMock.mockImplementationOnce(
      async ({ tools }: { tools?: ToolSet }) => {
        const launch = (await tools?.delegate_to_researcher?.execute?.(
          {
            prompt: "research this",
            run_in_background: true,
          },
          toolExecutionOptions()
        )) as { task_id: string };
        await tools?.background_output?.execute?.(
          { block: true, task_id: launch.task_id },
          toolExecutionOptions()
        );
        return { responseMessages: [assistantMessage("PARENT DONE")] };
      }
    );
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    const events = await collectRun(await agent.send(userText("delegate")));
    const update = events.find(
      (event) =>
        event.type === "subagent-job-update" &&
        event.eventType === "assistant-text"
    );

    expect(update).toEqual(
      expect.objectContaining({
        eventType: "assistant-text",
        status: "running",
        subagent: "researcher",
        textPreview: "CHILD DONE",
        type: "subagent-job-update",
      })
    );
    expect(eventTypes(events)).toContain("subagent-job-update");
  });
});
