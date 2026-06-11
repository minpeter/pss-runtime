import { describe, expect, it } from "vitest";
import { runAgentLoop } from "./agent-loop";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Empty,
  mockLanguageModelV4Text,
} from "./mock-language-model-v4-test-utils";
import type { AgentEvent } from "./session/events";
import { ModelMessageHistory } from "./session/history";
import { userTextToModelMessage } from "./session/mapping";
import {
  assistantMessage,
  createDeferred,
  createScriptedModelOptions,
  eventTypes,
  toolCallPart,
  toolResultFor,
  userText,
} from "./test-fixtures";

const noBoundaryDecision = undefined;

const nextMicrotask = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 1));

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await nextMicrotask();
  }
};

const seedUserTurn = (history: ModelMessageHistory) => {
  const message = userTextToModelMessage(userText("start"));
  history.appendModelMessage(message);
  return message;
};

describe("runAgentLoop", () => {
  it("continues after assistant messages request any tool", async () => {
    const events: AgentEvent[] = [];
    const history = new ModelMessageHistory();
    const userMessage = seedUserTurn(history);
    const toolCall = toolCallPart("call-tool-1");
    const model = createScriptedModelOptions([
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
      runAgentLoop({
        emit: (event) => {
          events.push(event);
        },
        history,
        model,
      })
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
    expect(history.modelSnapshot()).toMatchObject([
      userMessage,
      {
        content: [
          { text: "I should keep going.", type: "text" },
          {
            input: {},
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            type: "tool-call",
          },
        ],
        role: "assistant",
      },
      toolResultFor(toolCall),
      { content: [{ text: "DONE", type: "text" }], role: "assistant" },
    ]);
  });

  it("returns aborted when the LLM rejects after the signal is aborted", async () => {
    const events: AgentEvent[] = [];
    const history = new ModelMessageHistory();
    const userMessage = seedUserTurn(history);
    const controller = new AbortController();
    const model = createMockLanguageModelV4(() => {
      controller.abort();
      throw new Error("model request aborted");
    });

    await expect(
      runAgentLoop({
        emit: (event) => {
          events.push(event);
        },
        history,
        model: { model },
        signal: controller.signal,
      })
    ).resolves.toBe("aborted");

    expect(eventTypes(events)).toEqual(["step-start"]);
    expect(history.modelSnapshot()).toEqual([userMessage]);
  });

  it("returns aborted when the LLM resolves empty output after the signal is aborted", async () => {
    const events: AgentEvent[] = [];
    const history = new ModelMessageHistory();
    const userMessage = seedUserTurn(history);
    const controller = new AbortController();
    const model = createMockLanguageModelV4(() => {
      controller.abort();
      return Promise.resolve(mockLanguageModelV4Empty());
    });

    await expect(
      runAgentLoop({
        emit: (event) => {
          events.push(event);
        },
        history,
        model: { model },
        signal: controller.signal,
      })
    ).resolves.toBe("aborted");

    expect(eventTypes(events)).toEqual(["step-start"]);
    expect(history.modelSnapshot()).toEqual([userMessage]);
  });

  it("does not call the LLM until the awaited step-start boundary resolves", async () => {
    const events: AgentEvent[] = [];
    const history = new ModelMessageHistory();
    seedUserTurn(history);
    const stepStart = createDeferred();
    const model = createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]);

    const result = runAgentLoop({
      emit: (event) => {
        events.push(event);
        if (event.type === "step-start") {
          return stepStart.promise.then(() => noBoundaryDecision);
        }
        return noBoundaryDecision;
      },
      history,
      model: { model },
    });

    await nextMicrotask();

    expect(eventTypes(events)).toEqual(["step-start"]);
    expect(model.doGenerateCalls).toHaveLength(0);

    stepStart.resolve();

    await expect(result).resolves.toBe("completed");
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(eventTypes(events)).toEqual([
      "step-start",
      "assistant-text",
      "step-end",
    ]);
  });

  it("does not start the next LLM call until the awaited step-end boundary resolves", async () => {
    const events: AgentEvent[] = [];
    const history = new ModelMessageHistory();
    seedUserTurn(history);
    const firstStepEnd = createDeferred();
    const toolCall = toolCallPart("call-tool-1");
    let stepEndCount = 0;
    const model = createScriptedModelOptions([
      [assistantMessage([toolCall]), toolResultFor(toolCall)],
      [assistantMessage("DONE")],
    ]);

    const result = runAgentLoop({
      emit: (event) => {
        events.push(event);
        if (event.type === "step-end") {
          stepEndCount += 1;
          if (stepEndCount === 1) {
            return firstStepEnd.promise.then(() => noBoundaryDecision);
          }
        }
        return noBoundaryDecision;
      },
      history,
      model,
    });

    await waitFor(() => eventTypes(events).includes("step-end"));

    expect(model.model.doGenerateCalls).toHaveLength(1);
    expect(eventTypes(events)).toEqual([
      "step-start",
      "tool-call",
      "tool-result",
      "step-end",
    ]);

    firstStepEnd.resolve();

    await expect(result).resolves.toBe("completed");
    expect(model.model.doGenerateCalls).toHaveLength(2);
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
    const history = new ModelMessageHistory();
    seedUserTurn(history);
    const stepEnd = createDeferred();
    const model = createScriptedModelOptions([[assistantMessage("DONE")]]);
    let settled = false;

    const result = runAgentLoop({
      emit: (event) => {
        events.push(event);
        if (event.type === "step-end") {
          return stepEnd.promise.then(() => noBoundaryDecision);
        }
        return noBoundaryDecision;
      },
      history,
      model,
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
    const history = new ModelMessageHistory();
    const userMessage = seedUserTurn(history);
    let stepEndCount = 0;
    const model = createScriptedModelOptions([
      [assistantMessage("This could be final.")],
      [assistantMessage("DONE")],
    ]);

    await expect(
      runAgentLoop({
        emit: (event) => {
          events.push(event);
          if (event.type === "step-end") {
            stepEndCount += 1;
            return { runtimeInputAdded: stepEndCount === 1 };
          }
        },
        history,
        model,
      })
    ).resolves.toBe("completed");

    expect(model.model.doGenerateCalls).toHaveLength(2);
    expect(eventTypes(events)).toEqual([
      "step-start",
      "assistant-text",
      "step-end",
      "step-start",
      "assistant-text",
      "step-end",
    ]);
    expect(history.modelSnapshot()).toMatchObject([
      userMessage,
      {
        content: [{ text: "This could be final.", type: "text" }],
        role: "assistant",
      },
      { content: [{ text: "DONE", type: "text" }], role: "assistant" },
    ]);
  });

  it("returns aborted when aborted while waiting for a boundary", async () => {
    const events: AgentEvent[] = [];
    const history = new ModelMessageHistory();
    seedUserTurn(history);
    const controller = new AbortController();
    const stepStart = createDeferred();
    const model = createMockLanguageModelV4([mockLanguageModelV4Text("DONE")]);

    const result = runAgentLoop({
      emit: (event) => {
        events.push(event);
        if (event.type === "step-start") {
          return stepStart.promise.then(() => noBoundaryDecision);
        }
        return noBoundaryDecision;
      },
      history,
      model: { model },
      signal: controller.signal,
    });

    await nextMicrotask();
    controller.abort();

    await expect(result).resolves.toBe("aborted");
    expect(eventTypes(events)).toEqual(["step-start"]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
