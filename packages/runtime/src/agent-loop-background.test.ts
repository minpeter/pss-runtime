import { describe, expect, it } from "vitest";
import { runAgentLoop } from "./agent-loop";
import type { RuntimeLlm } from "./llm";
import type { AgentEvent } from "./session/events";
import { ModelMessageHistory } from "./session/history";
import { assistantMessage, eventTypes, toolCallPart } from "./test-fixtures";

describe("runAgentLoop tool results", () => {
  it("continues the model loop after a tool result", async () => {
    const events: AgentEvent[] = [];
    const history = new ModelMessageHistory();
    const toolCall = toolCallPart("call-tool-1", "lookup", {
      query: "research this",
    });
    let llmCalls = 0;
    const llm: RuntimeLlm = () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return Promise.resolve([
          assistantMessage([toolCall]),
          {
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
          },
        ]);
      }

      return Promise.resolve([assistantMessage("Lookup handled.")]);
    };

    await expect(
      runAgentLoop({
        emit: (event) => {
          events.push(event);
        },
        history,
        llm,
      })
    ).resolves.toBe("completed");

    expect(llmCalls).toBe(2);
    expect(eventTypes(events)).toEqual([
      "step-start",
      "tool-call",
      "tool-result",
      "step-end",
      "step-start",
      "assistant-text",
      "step-end",
    ]);
    expect(history.modelSnapshot()).toEqual([
      assistantMessage([toolCall]),
      {
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
      },
      assistantMessage("Lookup handled."),
    ]);
  });
});
