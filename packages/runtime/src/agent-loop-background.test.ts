import { describe, expect, it } from "vitest";
import { runAgentLoop } from "./agent-loop";
import type { RuntimeLlm } from "./llm";
import type { AgentEvent } from "./session/events";
import { ModelMessageHistory } from "./session/history";
import { assistantMessage, eventTypes, toolCallPart } from "./test-fixtures";

describe("runAgentLoop background delegation", () => {
  it("continues the model loop after a background launch tool result", async () => {
    const events: AgentEvent[] = [];
    const history = new ModelMessageHistory();
    const toolCall = toolCallPart("call-bg-1", "delegate_to_researcher", {
      prompt: "research this",
      run_in_background: true,
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
                    message: "Background job started.",
                    run_in_background: true,
                    status: "running",
                    subagent: "researcher",
                    task_id: "bg_123",
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

      return Promise.resolve([
        assistantMessage("Background task started; waiting for notification."),
      ]);
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
                message: "Background job started.",
                run_in_background: true,
                status: "running",
                subagent: "researcher",
                task_id: "bg_123",
              },
            },
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            type: "tool-result",
          },
        ],
        role: "tool",
      },
      assistantMessage("Background task started; waiting for notification."),
    ]);
  });
});
