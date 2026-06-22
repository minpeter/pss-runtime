import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import type { ExecutionHost } from "../../execution/host/types";
import { createInMemoryExecutionHost } from "../../execution/memory";
import { resumeRun } from "../../execution/resume/resume";
import { createQueuedUserTurnRun } from "../../testing/execution-checkpoint-test-support";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../../testing/mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createScriptedModelOptions,
  eventTypes,
  toolCallPart,
  toolResultFor,
  userText,
} from "../../testing/test-fixtures";
import type { AgentEvent } from "../../thread/protocol/events";
import { userTextToModelMessage } from "../../thread/protocol/mapping";

const collectEvents = async (
  host: ExecutionHost,
  runId = "run-1"
): Promise<AgentEvent[]> => {
  const events: AgentEvent[] = [];
  for await (const event of host.store.events.read(runId)) {
    events.push(event.event);
  }
  return events;
};
const queuedUserMessage = () => userTextToModelMessage(userText("queued"));

describe("resumeRun", () => {
  it("suspends without calling the model when maxSteps is zero", async () => {
    const host = createInMemoryExecutionHost();
    const model = createScriptedModelOptions([[assistantMessage("DONE")]]);
    await host.store.turns.create(createQueuedUserTurnRun());

    await expect(
      resumeRun({
        budget: { maxSteps: 0 },
        host,
        model,
        loadState: () => Promise.resolve({ history: [] }),
        runId: "run-1",
        saveState: () => Promise.resolve(),
      })
    ).resolves.toEqual({ status: "suspended", steps: 0 });

    expect(model.model.doGenerateCalls).toHaveLength(0);
    await expect(host.store.checkpoints.latest("run-1")).resolves.toBeNull();
  });

  it("aborts before writing a step when signal is already aborted", async () => {
    const host = createInMemoryExecutionHost();
    const controller = new AbortController();
    controller.abort();
    const model = createScriptedModelOptions([[assistantMessage("DONE")]]);
    await host.store.turns.create(createQueuedUserTurnRun());

    await expect(
      resumeRun({
        budget: { maxSteps: 1 },
        host,
        model,
        loadState: () => Promise.resolve({ history: [] }),
        runId: "run-1",
        saveState: () => Promise.resolve(),
        signal: controller.signal,
      })
    ).resolves.toEqual({ status: "aborted", steps: 0 });

    expect(model.model.doGenerateCalls).toHaveLength(0);
    expect(await collectEvents(host)).toEqual([]);
  });

  it("suspends after maxSteps and resumes to completion", async () => {
    const host = createInMemoryExecutionHost();
    const toolCall = toolCallPart("call-tool-1");
    const initialUserMessage = queuedUserMessage();
    const history: ModelMessage[] = [initialUserMessage];
    const model = createScriptedModelOptions([
      [
        assistantMessage([
          { text: "I need the tool.", type: "text" },
          toolCall,
        ]),
        toolResultFor(toolCall),
      ],
      [assistantMessage("DONE")],
    ]);
    await host.store.turns.create(createQueuedUserTurnRun());

    const first = await resumeRun({
      budget: { maxSteps: 1 },
      host,
      model,
      loadState: () => Promise.resolve({ history }),
      runId: "run-1",
      saveState: (state) => {
        history.length = 0;
        history.push(...state.history);
        return Promise.resolve();
      },
    });

    expect(first).toEqual({ status: "suspended", steps: 1 });
    await expect(host.store.checkpoints.latest("run-1")).resolves.toMatchObject(
      {
        phase: "suspended",
      }
    );

    const second = await resumeRun({
      budget: { maxSteps: 2 },
      host,
      model,
      loadState: () => Promise.resolve({ history }),
      runId: "run-1",
      saveState: (state) => {
        history.length = 0;
        history.push(...state.history);
        return Promise.resolve();
      },
    });

    expect(second).toEqual({ status: "completed", steps: 1 });
    expect(model.model.doGenerateCalls).toHaveLength(2);
    expect(eventTypes(await collectEvents(host))).toEqual([
      "step-start",
      "assistant-output",
      "tool-call",
      "tool-result",
      "step-end",
      "step-start",
      "assistant-output",
      "step-end",
    ]);
  });

  it("rolls back to before model when model output was not committed", async () => {
    const host = createInMemoryExecutionHost();
    const initialUserMessage = queuedUserMessage();
    const history: ModelMessage[] = [initialUserMessage];
    let modelCalls = 0;
    let failCommit = true;
    const model = createMockLanguageModelV4(() => {
      modelCalls += 1;
      return Promise.resolve(mockLanguageModelV4Text(`attempt ${modelCalls}`));
    });
    await host.store.turns.create(createQueuedUserTurnRun());

    await expect(
      resumeRun({
        budget: { maxSteps: 1 },
        host,
        model: { model },
        loadState: () => Promise.resolve({ history }),
        runId: "run-1",
        saveState: (state) => {
          if (failCommit) {
            failCommit = false;
            return Promise.reject(new Error("state commit failed"));
          }
          history.length = 0;
          history.push(...state.history);
          return Promise.resolve();
        },
      })
    ).rejects.toThrow("state commit failed");

    await expect(host.store.checkpoints.latest("run-1")).resolves.toMatchObject(
      {
        phase: "before-model",
      }
    );
    expect(history).toEqual([initialUserMessage]);

    await expect(
      resumeRun({
        budget: { maxSteps: 1 },
        host,
        model: { model },
        loadState: () => Promise.resolve({ history }),
        runId: "run-1",
        saveState: (state) => {
          history.length = 0;
          history.push(...state.history);
          return Promise.resolve();
        },
      })
    ).resolves.toEqual({ status: "completed", steps: 1 });

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(eventTypes(await collectEvents(host))).toEqual([
      "step-start",
      "assistant-output",
      "step-end",
    ]);
    expect(history).toMatchObject([
      initialUserMessage,
      {
        content: [{ text: "attempt 2", type: "text" }],
        role: "assistant",
      },
    ]);
  });
});
