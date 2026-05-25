import { describe, expect, it } from "vitest";
import { runAgentLoop } from "./agent-loop";
import type { Llm } from "./llm";
import type { AgentEvent } from "./session/events";
import { AgentModelHistory } from "./session/history";
import {
  assistantMessage,
  createDeferred,
  createScriptedLlm,
  eventTypes,
  toolCallPart,
  toolResultFor,
} from "./test-fixtures";

const nextMicrotask = () =>
  new Promise<void>((resolve) => queueMicrotask(() => resolve()));

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }
    await nextMicrotask();
  }
};

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
      runAgentLoop({ emit: (event) => void events.push(event), history, llm })
    ).resolves.toBe("completed");

    expect(events).toEqual([
      { type: "step-start" },
      { type: "assistant-text", text: "I should keep going." },
      {
        type: "tool-call",
        input: {},
        toolCallId: "call-tool-1",
        toolName: "test_tool",
      },
      {
        type: "tool-result",
        output: { type: "json", value: {} },
        toolCallId: "call-tool-1",
        toolName: "test_tool",
      },
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
        emit: (event) => void events.push(event),
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
        emit: (event) => void events.push(event),
        history,
        llm: emptyAbortingLlm,
        signal: controller.signal,
      })
    ).resolves.toBe("aborted");

    expect(eventTypes(events)).toEqual(["step-start"]);
    expect(history.modelSnapshot()).toEqual([]);
  });

  it("does not call the LLM until the awaited step-start boundary resolves", async () => {
    const events: AgentEvent[] = [];
    const history = new AgentModelHistory();
    const stepStart = createDeferred();
    let llmCalls = 0;
    const llm: Llm = () => {
      llmCalls += 1;
      return Promise.resolve([assistantMessage("DONE")]);
    };

    const result = runAgentLoop({
      emit: (event) => {
        void events.push(event);
        if (event.type === "step-start") {
          return stepStart.promise;
        }
      },
      history,
      llm,
    });

    await nextMicrotask();

    expect(eventTypes(events)).toEqual(["step-start"]);
    expect(llmCalls).toBe(0);

    stepStart.resolve();

    await expect(result).resolves.toBe("completed");
    expect(llmCalls).toBe(1);
    expect(eventTypes(events)).toEqual([
      "step-start",
      "assistant-text",
      "step-end",
    ]);
  });

  it("does not start the next LLM call until the awaited step-end boundary resolves", async () => {
    const events: AgentEvent[] = [];
    const history = new AgentModelHistory();
    const firstStepEnd = createDeferred();
    const toolCall = toolCallPart("call-tool-1");
    let llmCalls = 0;
    let stepEndCount = 0;
    const llm = createScriptedLlm([
      [assistantMessage([toolCall]), toolResultFor(toolCall)],
      [assistantMessage("DONE")],
    ]);
    const countingLlm: Llm = (context) => {
      llmCalls += 1;
      return llm(context);
    };

    const result = runAgentLoop({
      emit: (event) => {
        void events.push(event);
        if (event.type === "step-end") {
          stepEndCount += 1;
          if (stepEndCount === 1) {
            return firstStepEnd.promise;
          }
        }
      },
      history,
      llm: countingLlm,
    });

    await waitFor(() => eventTypes(events).includes("step-end"));

    expect(llmCalls).toBe(1);
    expect(eventTypes(events)).toEqual([
      "step-start",
      "tool-call",
      "tool-result",
      "step-end",
    ]);

    firstStepEnd.resolve();

    await expect(result).resolves.toBe("completed");
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
  });

  it("does not complete until the awaited final step-end boundary resolves", async () => {
    const events: AgentEvent[] = [];
    const history = new AgentModelHistory();
    const stepEnd = createDeferred();
    const llm = createScriptedLlm([[assistantMessage("DONE")]]);
    let settled = false;

    const result = runAgentLoop({
      emit: (event) => {
        void events.push(event);
        if (event.type === "step-end") {
          return stepEnd.promise;
        }
      },
      history,
      llm,
    }).then((value) => {
      settled = true;
      return value;
    });

    await waitFor(() => eventTypes(events).includes("step-end"));

    expect(eventTypes(events)).toEqual([
      "step-start",
      "assistant-text",
      "step-end",
    ]);
    expect(settled).toBe(false);

    stepEnd.resolve();

    await expect(result).resolves.toBe("completed");
    expect(settled).toBe(true);
  });

  it("continues after step-end boundary input even without a tool call", async () => {
    const events: AgentEvent[] = [];
    const history = new AgentModelHistory();
    let llmCalls = 0;
    let stepEndCount = 0;
    const llm = createScriptedLlm([
      [assistantMessage("This could be final.")],
      [assistantMessage("DONE")],
    ]);
    const countingLlm: Llm = (context) => {
      llmCalls += 1;
      return llm(context);
    };

    await expect(
      runAgentLoop({
        emit: (event) => {
          void events.push(event);
          if (event.type === "step-end") {
            stepEndCount += 1;
            return { runtimeInputAdded: stepEndCount === 1 };
          }
        },
        history,
        llm: countingLlm,
      })
    ).resolves.toBe("completed");

    expect(llmCalls).toBe(2);
    expect(eventTypes(events)).toEqual([
      "step-start",
      "assistant-text",
      "step-end",
      "step-start",
      "assistant-text",
      "step-end",
    ]);
    expect(history.modelSnapshot()).toEqual([
      assistantMessage("This could be final."),
      assistantMessage("DONE"),
    ]);
  });

  it("returns aborted when aborted while waiting for a boundary", async () => {
    const events: AgentEvent[] = [];
    const history = new AgentModelHistory();
    const controller = new AbortController();
    const stepStart = createDeferred();
    let llmCalls = 0;
    const llm: Llm = () => {
      llmCalls += 1;
      return Promise.resolve([assistantMessage("DONE")]);
    };

    const result = runAgentLoop({
      emit: (event) => {
        void events.push(event);
        if (event.type === "step-start") {
          return stepStart.promise;
        }
      },
      history,
      llm,
      signal: controller.signal,
    });

    await nextMicrotask();
    controller.abort();

    await expect(result).resolves.toBe("aborted");
    expect(eventTypes(events)).toEqual(["step-start"]);
    expect(llmCalls).toBe(0);
  });
});
