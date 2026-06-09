import type { ToolSet } from "ai";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi } from "vitest";
import {
  collectRun,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
  toolExecutionOptions,
  } from "./llm-test-utils";
import {
  assistantMessage,
  eventTypes,
  toolCallPart,
  toolResultFor,
  userText,
  researcherSubagent,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();
const blockingDelegateToolCallId = "call_7eTeYjF9tUaDKah9T3mwUQpA";

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
    const researcher = researcherSubagent({

      model: async () => [assistantMessage("CHILD DONE")],

    });    generateTextMock.mockImplementationOnce(
      async ({ tools }: { tools?: ToolSet }) => {
        await tools?.delegate_to_researcher?.execute?.(
          { prompt: "research this" },
          {
            ...toolExecutionOptions(),
            toolCallId: blockingDelegateToolCallId,
          }
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
        delegateToolCallId: blockingDelegateToolCallId,
        subagent: "researcher",
        type: "subagent-job-start",
      })
    );
    expect(start).not.toHaveProperty(
      "delegateToolCallId",
      "delegate_to_researcher:0"
    );
    expect(start).not.toHaveProperty("parentToolCallId");
    expect(start).not.toHaveProperty("sessionKey");
    expect(end).toEqual(
      expect.objectContaining({
        delegateToolCallId: blockingDelegateToolCallId,
        eventCount: expect.any(Number),
        status: "completed",
        subagent: "researcher",
        type: "subagent-job-end",
      })
    );
    expect(end).not.toHaveProperty("parentToolCallId");
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
    const researcher = researcherSubagent({

      model: async () => [assistantMessage("CHILD DONE")],

    });    generateTextMock.mockImplementationOnce(
      async ({ tools }: { tools?: ToolSet }) => {
        await tools?.delegate_to_researcher?.execute?.(
          { prompt: "research this" },
          {
            ...toolExecutionOptions(),
            toolCallId: "call_93XP9pImzGPvxIlwqKBxy0QU",
          }
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

  it("keeps buffered subagent lifecycle events visible when the parent model call fails", async () => {
    const Agent = await loadAgent();
    const researcher = researcherSubagent({

      model: async () => [assistantMessage("CHILD DONE")],

    });    generateTextMock.mockImplementationOnce(
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
});
