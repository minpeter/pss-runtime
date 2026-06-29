import { describe, expect, it } from "vitest";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createDeferred,
  createScriptedModelOptions,
  eventTypes,
  toolCallPart,
  toolResultFor,
  userText,
} from "../../testing/test-fixtures";
import type { AgentEvent } from "../../thread/protocol/events";
import { userTextToModelMessage } from "../../thread/protocol/mapping";
import { ModelMessageHistory } from "../../thread/state/history";
import { runAgentLoop } from "./loop";

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

describe("runAgentLoop boundary awaits", () => {
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
      "assistant-output",
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
      "assistant-output",
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
      "assistant-output",
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
      "assistant-output",
      "step-end",
      "step-start",
      "assistant-output",
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
