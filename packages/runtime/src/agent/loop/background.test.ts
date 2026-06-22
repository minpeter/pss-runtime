import type { ToolModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  assistantMessage,
  createScriptedModelOptions,
  eventTypes,
  toolCallPart,
  userText,
} from "../../testing/test-fixtures";
import type { AgentEvent } from "../../thread/protocol/events";
import { userTextToModelMessage } from "../../thread/protocol/mapping";
import { ModelMessageHistory } from "../../thread/state/history";
import { runAgentLoop } from "./loop";

describe("runAgentLoop tool results", () => {
  it("continues the model loop after a tool result", async () => {
    const events: AgentEvent[] = [];
    const history = new ModelMessageHistory();
    const userMessage = userTextToModelMessage(userText("start"));
    history.appendModelMessage(userMessage);
    const toolCall = toolCallPart("call-tool-1", "lookup", {
      query: "research this",
    });
    const toolResult = {
      content: [
        {
          output: {
            type: "json",
            value: {
              message: "Lookup completed.",
              status: "completed",
            },
          },
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          type: "tool-result",
        },
      ],
      role: "tool",
    } satisfies ToolModelMessage;
    const model = createScriptedModelOptions([
      [assistantMessage([toolCall]), toolResult],
      [assistantMessage("Lookup handled.")],
    ]);

    await expect(
      runAgentLoop({
        emit: (event) => {
          events.push(event);
        },
        history,
        model,
      })
    ).resolves.toBe("completed");

    expect(model.model.doGenerateCalls).toHaveLength(2);
    expect(eventTypes(events)).toEqual([
      "step-start",
      "tool-call",
      "tool-result",
      "step-end",
      "step-start",
      "assistant-output",
      "step-end",
    ]);
    expect(history.modelSnapshot()).toMatchObject([
      userMessage,
      {
        content: [
          {
            input: { query: "research this" },
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      toolResult,
      {
        content: [{ text: "Lookup handled.", type: "text" }],
        role: "assistant",
      },
    ]);
  });
});
