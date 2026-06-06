import type { ToolSet } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectRun,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
  toolExecutionOptions,
} from "./llm-test-utils";
import {
  assistantMessage,
  createDeferred,
  eventTypes,
  toolCallPart,
  toolResultFor,
  userText,
} from "./test-fixtures";

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
        subagent: "researcher",
        type: "subagent-job-start",
      })
    );
    expect(start).not.toHaveProperty("sessionKey");
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

  it("orders blocking subagent lifecycle events between parent tool-call and tool-result", async () => {
    const Agent = await loadAgent();
    const toolCall = toolCallPart(
      "call-delegate-order",
      "delegate_to_researcher",
      {
        prompt: "research this",
      }
    );
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
        return {
          responseMessages: [
            assistantMessage([toolCall]),
            toolResultFor(toolCall),
          ],
        };
      }
    );
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    const events = await collectRun(await agent.send(userText("delegate")));

    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "tool-call",
      "subagent-job-start",
      "subagent-job-end",
      "tool-result",
      "step-end",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
  });

  it("orders background subagent launch after parent tool-call while streaming later updates live", async () => {
    const Agent = await loadAgent();
    const childGate = createDeferred();
    const toolCall = toolCallPart(
      "call-background-order",
      "delegate_to_researcher",
      {
        prompt: "research this",
        run_in_background: true,
      }
    );
    const researcher = new Agent({
      description: "Researches facts.",
      llm: async () => {
        await childGate.promise;
        return [assistantMessage("CHILD DONE")];
      },
      name: "researcher",
    });
    generateTextMock.mockImplementationOnce(
      async ({ tools }: { tools?: ToolSet }) => {
        await tools?.delegate_to_researcher?.execute?.(
          {
            prompt: "research this",
            run_in_background: true,
          },
          toolExecutionOptions()
        );
        return {
          responseMessages: [
            assistantMessage([toolCall]),
            toolResultFor(toolCall),
          ],
        };
      }
    );
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    const iterator = (await agent.send(userText("delegate")))
      .events()
      [Symbol.asyncIterator]();
    const events: string[] = [];
    while (!events.includes("tool-result")) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (!next.done) {
        events.push(next.value.type);
      }
    }

    expect(events.indexOf("tool-call")).toBeLessThan(
      events.indexOf("subagent-job-start")
    );
    expect(events.indexOf("subagent-job-start")).toBeLessThan(
      events.indexOf("tool-result")
    );

    childGate.resolve();

    while (!events.includes("turn-end")) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      events.push(next.value.type);
    }

    expect(events.indexOf("subagent-job-update")).toBeGreaterThan(
      events.indexOf("tool-result")
    );
    expect(events.indexOf("subagent-job-end")).toBeGreaterThan(
      events.indexOf("tool-result")
    );
  });

  it("keeps buffered subagent lifecycle events visible when the parent model call fails", async () => {
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
        throw new Error("parent model failed");
      }
    );
    const agent = new Agent({ model: fakeModel, subagents: [researcher] });

    const events = await collectRun(await agent.send(userText("delegate")));

    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "subagent-job-start",
      "subagent-job-end",
      "turn-error",
    ]);
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
        type: "subagent-job-update",
      })
    );
    expect(update).not.toHaveProperty("textPreview");
    expect(JSON.stringify(update)).not.toContain("CHILD DONE");
    expect(eventTypes(events)).toContain("subagent-job-update");
  });
});
