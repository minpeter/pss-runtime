import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { createInMemoryExecutionHost } from "./execution/memory";
import { resumeRun } from "./execution/resume";
import type { ExecutionHost } from "./execution/types";
import { createQueuedUserTurnRun } from "./execution-checkpoint-test-support";
import type { RuntimeLlm } from "./llm";
import type { AgentEvent } from "./session/events";
import {
  assistantMessage,
  eventTypes,
  toolCallPart,
  toolResultFor,
} from "./test-fixtures";

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

describe("resumeRun", () => {
  it("suspends without calling the model when maxSteps is zero", async () => {
    const host = createInMemoryExecutionHost();
    let llmCalls = 0;
    const llm: RuntimeLlm = () => {
      llmCalls += 1;
      return Promise.resolve([assistantMessage("DONE")]);
    };
    await host.store.runs.create(createQueuedUserTurnRun());

    await expect(
      resumeRun({
        budget: { maxSteps: 0 },
        host,
        llm,
        loadState: () => Promise.resolve({ history: [] }),
        runId: "run-1",
        saveState: () => Promise.resolve(),
      })
    ).resolves.toEqual({ status: "suspended", steps: 0 });

    expect(llmCalls).toBe(0);
    await expect(host.store.checkpoints.latest("run-1")).resolves.toBeNull();
  });

  it("aborts before writing a step when signal is already aborted", async () => {
    const host = createInMemoryExecutionHost();
    const controller = new AbortController();
    controller.abort();
    let llmCalls = 0;
    const llm: RuntimeLlm = () => {
      llmCalls += 1;
      return Promise.resolve([assistantMessage("DONE")]);
    };
    await host.store.runs.create(createQueuedUserTurnRun());

    await expect(
      resumeRun({
        budget: { maxSteps: 1 },
        host,
        llm,
        loadState: () => Promise.resolve({ history: [] }),
        runId: "run-1",
        saveState: () => Promise.resolve(),
        signal: controller.signal,
      })
    ).resolves.toEqual({ status: "aborted", steps: 0 });

    expect(llmCalls).toBe(0);
    expect(await collectEvents(host)).toEqual([]);
  });

  it("suspends after maxSteps and resumes to completion", async () => {
    const host = createInMemoryExecutionHost();
    const toolCall = toolCallPart("call-tool-1");
    const history: ModelMessage[] = [];
    let llmCalls = 0;
    const llm: RuntimeLlm = () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return Promise.resolve([
          assistantMessage([
            { text: "I need the tool.", type: "text" },
            toolCall,
          ]),
          toolResultFor(toolCall),
        ]);
      }
      return Promise.resolve([assistantMessage("DONE")]);
    };
    await host.store.runs.create(createQueuedUserTurnRun());

    const first = await resumeRun({
      budget: { maxSteps: 1 },
      host,
      llm,
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
      llm,
      loadState: () => Promise.resolve({ history }),
      runId: "run-1",
      saveState: (state) => {
        history.length = 0;
        history.push(...state.history);
        return Promise.resolve();
      },
    });

    expect(second).toEqual({ status: "completed", steps: 1 });
    expect(llmCalls).toBe(2);
    expect(eventTypes(await collectEvents(host))).toEqual([
      "step-start",
      "assistant-text",
      "tool-call",
      "tool-result",
      "step-end",
      "step-start",
      "assistant-text",
      "step-end",
    ]);
  });

  it("rolls back to before model when model output was not committed", async () => {
    const host = createInMemoryExecutionHost();
    const history: ModelMessage[] = [];
    let llmCalls = 0;
    let failCommit = true;
    const llm: RuntimeLlm = () => {
      llmCalls += 1;
      return Promise.resolve([assistantMessage(`attempt ${llmCalls}`)]);
    };
    await host.store.runs.create(createQueuedUserTurnRun());

    await expect(
      resumeRun({
        budget: { maxSteps: 1 },
        host,
        llm,
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
    expect(history).toEqual([]);

    await expect(
      resumeRun({
        budget: { maxSteps: 1 },
        host,
        llm,
        loadState: () => Promise.resolve({ history }),
        runId: "run-1",
        saveState: (state) => {
          history.length = 0;
          history.push(...state.history);
          return Promise.resolve();
        },
      })
    ).resolves.toEqual({ status: "completed", steps: 1 });

    expect(llmCalls).toBe(2);
    expect(eventTypes(await collectEvents(host))).toEqual([
      "step-start",
      "assistant-text",
      "step-end",
    ]);
    expect(history).toEqual([assistantMessage("attempt 2")]);
  });
});
