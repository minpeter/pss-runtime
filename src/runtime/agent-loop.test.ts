import { describe, expect, it } from "vitest";
import { runAgentLoop } from "./agent-loop";
import type { Llm } from "./llm";
import type { AgentEvent } from "./session/events";
import { AgentModelHistory } from "./session/history";
import {
  assistantMessage,
  createScriptedLlm,
  eventTypes,
  toolCallPart,
  toolResultFor,
} from "./test-fixtures";

describe("runAgentLoop", () => {
  it("continues after assistant messages request any tool", async () => {
    const events: AgentEvent[] = [];
    const history = new AgentModelHistory();
    const toolCall = toolCallPart("call-tool-1");
    const llm = createScriptedLlm([
      [
        assistantMessage([
          { type: "text", text: "I should keep going." },
          toolCall,
        ]),
        toolResultFor(toolCall),
      ],
      [assistantMessage("DONE")],
    ]);

    await expect(
      runAgentLoop({ emit: (event) => events.push(event), history, llm })
    ).resolves.toBe("completed");

    expect(events).toEqual([
      { type: "step-start" },
      { type: "assistant-text", text: "I should keep going." },
      { type: "tool-call", toolName: "test_tool" },
      { type: "step-end" },
      { type: "step-start" },
      { type: "assistant-text", text: "DONE" },
      { type: "step-end" },
    ]);
    expect(history.modelSnapshot()).toEqual([
      assistantMessage([
        { type: "text", text: "I should keep going." },
        toolCall,
      ]),
      toolResultFor(toolCall),
      assistantMessage("DONE"),
    ]);
  });

  it("returns aborted when the LLM rejects after the signal is aborted", async () => {
    const events: AgentEvent[] = [];
    const history = new AgentModelHistory();
    const controller = new AbortController();
    const abortingLlm: Llm = () => {
      controller.abort();
      return Promise.reject(new Error("model request aborted"));
    };

    await expect(
      runAgentLoop({
        emit: (event) => events.push(event),
        history,
        llm: abortingLlm,
        signal: controller.signal,
      })
    ).resolves.toBe("aborted");

    expect(eventTypes(events)).toEqual(["step-start"]);
    expect(history.modelSnapshot()).toEqual([]);
  });

  it("returns aborted when the LLM resolves empty output after the signal is aborted", async () => {
    const events: AgentEvent[] = [];
    const history = new AgentModelHistory();
    const controller = new AbortController();
    const emptyAbortingLlm: Llm = () => {
      controller.abort();
      return Promise.resolve([]);
    };

    await expect(
      runAgentLoop({
        emit: (event) => events.push(event),
        history,
        llm: emptyAbortingLlm,
        signal: controller.signal,
      })
    ).resolves.toBe("aborted");

    expect(eventTypes(events)).toEqual(["step-start"]);
    expect(history.modelSnapshot()).toEqual([]);
  });
});
