import { describe, expect, it } from "vitest";
import { runAgentLoop } from "./agent-loop";
import type { Llm } from "./llm";
import type { AgentEvent } from "./session/events";
import { AgentModelHistory } from "./session/history";
import {
  assistantMessage,
  continueToolCall,
  continueToolResult,
  eventTypes,
} from "./test-fixtures";

const continueToolHistoryMarker = (count: number) => ({
  role: "user" as const,
  content: `[internal tool result] The continue tool call completed successfully for this step. Count completed in this step: ${count}. If more internal loop steps are still required, call continue again; otherwise answer normally without more continue calls.`,
});

describe("runAgentLoop", () => {
  it("continues while assistant messages request the continue tool", async () => {
    const events: AgentEvent[] = [];
    const history = new AgentModelHistory();
    const seenHistory: ReturnType<AgentModelHistory["modelSnapshot"]>[] = [];
    const toolCall = continueToolCall("call-continue-1");
    const llm: Llm = ({ history }) => {
      seenHistory.push([...history]);

      if (seenHistory.length === 1) {
        return Promise.resolve([
          assistantMessage([
            { type: "text", text: "I should keep going." },
            toolCall,
          ]),
          continueToolResult(toolCall),
        ]);
      }

      return Promise.resolve([assistantMessage("DONE")]);
    };

    await expect(
      runAgentLoop({ emit: (event) => events.push(event), history, llm })
    ).resolves.toBe("completed");

    expect(seenHistory).toEqual([
      [],
      [
        assistantMessage([{ type: "text", text: "I should keep going." }]),
        continueToolHistoryMarker(1),
      ],
    ]);
    expect(events).toEqual([
      { type: "step-start" },
      { type: "assistant-text", text: "I should keep going." },
      { type: "tool-call", toolName: "continue" },
      { type: "step-end" },
      { type: "step-start" },
      { type: "assistant-text", text: "DONE" },
      { type: "step-end" },
    ]);
    expect(history.modelSnapshot()).toEqual([
      assistantMessage([{ type: "text", text: "I should keep going." }]),
      continueToolHistoryMarker(1),
      assistantMessage("DONE"),
    ]);
  });

  it("replaces continue-only tool protocol with a safe history marker", async () => {
    const events: AgentEvent[] = [];
    const history = new AgentModelHistory();
    const seenHistory: ReturnType<AgentModelHistory["modelSnapshot"]>[] = [];
    const toolCall = continueToolCall("call-continue-only");
    const llm: Llm = ({ history }) => {
      seenHistory.push([...history]);

      if (seenHistory.length === 1) {
        return Promise.resolve([
          assistantMessage([toolCall]),
          continueToolResult(toolCall),
        ]);
      }

      return Promise.resolve([assistantMessage("DONE")]);
    };

    await expect(
      runAgentLoop({ emit: (event) => events.push(event), history, llm })
    ).resolves.toBe("completed");

    expect(seenHistory).toEqual([[], [continueToolHistoryMarker(1)]]);
    expect(events).toEqual([
      { type: "step-start" },
      { type: "tool-call", toolName: "continue" },
      { type: "step-end" },
      { type: "step-start" },
      { type: "assistant-text", text: "DONE" },
      { type: "step-end" },
    ]);
    expect(history.modelSnapshot()).toEqual([
      continueToolHistoryMarker(1),
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
