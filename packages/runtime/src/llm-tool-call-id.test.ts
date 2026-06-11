import type { ToolSet } from "ai";
import { jsonSchema, tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectRun,
  executableTool,
  fakeModel,
  getGenerateTextMock,
  loadAgent,
  loadModelStepRunner,
} from "./llm-test-utils";
import {
  assistantMessage,
  toolCallPart,
  toolResultFor,
  userText,
} from "./test-fixtures";

const generateTextMock = getGenerateTextMock();
const generatedToolCallIdPattern = /^call_[0-9a-f]{32}$/;
const rawSyntheticToolCallId = "delegate_to_researcher_0";

describe("runtime tool call ids", () => {
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

  it("uses call-prefixed AI SDK fallback ids for tool calls", async () => {
    const runModelStep = await loadModelStepRunner();
    const signal = new AbortController().signal;
    const executeOptionsSeen: string[] = [];

    generateTextMock.mockImplementationOnce(async (options) => {
      const toolCall = toolCallPart(
        rawSyntheticToolCallId,
        "delegate_to_researcher",
        { prompt: "research", run_in_background: true }
      );
      await executableTool(
        options.tools as ToolSet,
        "delegate_to_researcher"
      ).execute?.(
        { prompt: "research", run_in_background: true },
        {
          abortSignal: signal,
          context: undefined,
          messages: [],
          toolCallId: rawSyntheticToolCallId,
        }
      );

      return {
        responseMessages: [
          assistantMessage([toolCall]),
          toolResultFor(toolCall),
        ],
      };
    });

    const output = await runModelStep(
      {
        model: fakeModel,
        tools: {
          delegate_to_researcher: createRecordingTool(executeOptionsSeen),
        },
      },
      { history: [], signal }
    );
    const assistant = output[0];
    const toolResult = output[1];
    if (
      assistant?.role !== "assistant" ||
      typeof assistant.content === "string" ||
      assistant.content[0]?.type !== "tool-call" ||
      toolResult?.role !== "tool" ||
      toolResult.content[0]?.type !== "tool-result"
    ) {
      throw new Error("expected tool call and tool result messages");
    }

    const toolCallId = assistant.content[0].toolCallId;
    expect(toolCallId).toMatch(generatedToolCallIdPattern);
    expect(toolCallId).not.toBe(rawSyntheticToolCallId);
    expect(toolResult.content[0]?.toolCallId).toBe(toolCallId);
    expect(executeOptionsSeen).toEqual([toolCallId]);
  });

  it("emits call-prefixed ids on agent tool event surfaces", async () => {
    const Agent = await loadAgent();
    const executeOptionsSeen: string[] = [];
    generateTextMock.mockImplementationOnce(async (options) => {
      const toolCall = toolCallPart(
        rawSyntheticToolCallId,
        "delegate_to_researcher",
        { prompt: "research", run_in_background: true }
      );
      await executableTool(
        options.tools as ToolSet,
        "delegate_to_researcher"
      ).execute?.(
        { prompt: "research", run_in_background: true },
        {
          abortSignal: new AbortController().signal,
          context: undefined,
          messages: [],
          toolCallId: rawSyntheticToolCallId,
        }
      );

      return {
        responseMessages: [
          assistantMessage([toolCall]),
          toolResultFor(toolCall),
        ],
      };
    });
    const agent = new Agent({
      model: fakeModel,
      tools: {
        delegate_to_researcher: createRecordingTool(executeOptionsSeen),
      },
    });

    const events = await collectRun(await agent.send(userText("delegate")));
    const toolCall = events.find((event) => event.type === "tool-call");
    const toolResult = events.find((event) => event.type === "tool-result");

    expect(toolCall).toEqual(
      expect.objectContaining({
        toolCallId: expect.stringMatching(generatedToolCallIdPattern),
        toolName: "delegate_to_researcher",
        type: "tool-call",
      })
    );
    if (toolCall?.type !== "tool-call") {
      throw new Error("expected tool-call event");
    }
    expect(toolCall.toolCallId).not.toBe(rawSyntheticToolCallId);
    expect(toolResult).toEqual(
      expect.objectContaining({
        toolCallId: toolCall.toolCallId,
        toolName: "delegate_to_researcher",
        type: "tool-result",
      })
    );
    expect(executeOptionsSeen).toEqual([toolCall.toolCallId]);
  });
});

function createRecordingTool(executeOptionsSeen: string[]) {
  return tool({
    execute: (_input, options) => {
      executeOptionsSeen.push(options.toolCallId);
      return {};
    },
    inputSchema: jsonSchema({
      additionalProperties: false,
      properties: {},
      type: "object",
    }),
  });
}
