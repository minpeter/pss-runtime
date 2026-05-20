import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import type { Llm } from "../llm";
import {
  assistantMessage,
  createDeferred,
  eventTypes,
  toolCallPart,
  toolResultFor,
  userText,
} from "../test-fixtures";
import type { AgentEvent } from "./events";
import { userTextToModelMessage } from "./mapping";

describe("AgentSession", () => {
  it("queues submitted input and aborts the active turn before the next input runs", async () => {
    const firstLlmCall = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const llm: Llm = async ({ history }) => {
      calls += 1;
      seenHistory.push([...history]);

      if (calls === 1) {
        await firstLlmCall.promise;
        const toolCall = toolCallPart("call-interrupted-tool");
        return [assistantMessage([toolCall]), toolResultFor(toolCall)];
      }

      return [assistantMessage("DONE")];
    };
    const session = new Agent({ llm }).createSession();
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));

    const firstSubmit = session.submit(userText("first"));
    const secondSubmit = session.submit(userText("second"));

    session.interrupt();
    firstLlmCall.resolve();

    await Promise.all([firstSubmit, secondSubmit]);

    expect(calls).toBe(2);
    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText("first"))],
      [
        userTextToModelMessage(userText("first")),
        userTextToModelMessage(userText("second")),
      ],
    ]);
    expect(events).toEqual([
      { type: "user-text", text: "first" },
      { type: "turn-start" },
      { type: "step-start" },
      { type: "user-text", text: "second" },
      { type: "turn-abort" },
      { type: "turn-start" },
      { type: "step-start" },
      { type: "assistant-text", text: "DONE" },
      { type: "step-end" },
      { type: "turn-end" },
    ]);
  });

  it("continues the model loop after a tool call result", async () => {
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const session = new Agent({
      llm: ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);

        if (calls === 1) {
          const toolCall = toolCallPart("call-tool-loop-1");
          return Promise.resolve([
            assistantMessage([toolCall]),
            toolResultFor(toolCall),
          ]);
        }

        return Promise.resolve([assistantMessage("DONE")]);
      },
    }).createSession();

    await session.submit(userText("remember me"));

    const toolCall = toolCallPart("call-tool-loop-1");
    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText("remember me"))],
      [
        userTextToModelMessage(userText("remember me")),
        assistantMessage([toolCall]),
        toolResultFor(toolCall),
      ],
    ]);
  });

  it("emits turn-error and rejects the submitted input when the LLM fails", async () => {
    const session = new Agent({
      llm: () => Promise.reject(new Error("model unavailable")),
    }).createSession();
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));

    await expect(session.submit(userText("fail"))).rejects.toThrow(
      "model unavailable"
    );

    expect(events).toEqual([
      { type: "user-text", text: "fail" },
      { type: "turn-start" },
      { type: "step-start" },
      { type: "turn-error", message: "model unavailable" },
    ]);
  });

  it("kills the session by aborting active work and rejecting queued input", async () => {
    const llmCall = createDeferred();
    let calls = 0;
    const session = new Agent({
      llm: async () => {
        calls += 1;
        await llmCall.promise;
        return [assistantMessage("should not render")];
      },
    }).createSession();
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));

    const activeSubmit = session.submit(userText("active"));
    const queuedSubmit = session.submit(userText("queued"));
    const queuedResult = queuedSubmit.then(
      () => "resolved",
      (error: unknown) => error
    );

    session.kill();
    llmCall.resolve();

    await activeSubmit;
    const queuedError = await queuedResult;

    expect(calls).toBe(1);
    expect(queuedError).toBeInstanceOf(Error);
    expect((queuedError as Error).message).toBe("Session killed");
    await expect(session.submit(userText("after kill"))).rejects.toThrow(
      "Session killed"
    );
    expect(events).toEqual([
      { type: "user-text", text: "active" },
      { type: "turn-start" },
      { type: "step-start" },
      { type: "user-text", text: "queued" },
      { type: "turn-abort" },
    ]);
  });

  it("kills the session by unblocking pending history persistence", async () => {
    const writeStarted = createDeferred();
    const write = createDeferred();
    let calls = 0;
    const session = new Agent({
      llm: () => {
        calls += 1;
        return Promise.resolve([assistantMessage("should not run")]);
      },
    }).createSession({
      onHistoryChange: async () => {
        writeStarted.resolve();
        await write.promise;
      },
    });
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));

    const activeSubmit = session.submit(userText("active"));
    const queuedSubmit = session.submit(userText("queued"));
    const queuedResult = queuedSubmit.then(
      () => "resolved",
      (error: unknown) => error
    );

    await writeStarted.promise;
    session.kill();

    await expect(settleWithin(activeSubmit)).resolves.toBe("resolved");
    const queuedError = await queuedResult;

    expect(calls).toBe(0);
    expect(session.getHistory()).toEqual([]);
    expect(queuedError).toBeInstanceOf(Error);
    expect((queuedError as Error).message).toBe("Session killed");
    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "user-text",
      "turn-abort",
    ]);
  });

  it("queues rollback persistence after kill without blocking on the stalled write", async () => {
    const firstWriteStarted = createDeferred();
    const releaseFirstWrite = createDeferred();
    const rollbackPersisted = createDeferred();
    const persistedLengths: number[] = [];
    let calls = 0;
    const session = new Agent({
      llm: () => {
        calls += 1;
        return Promise.resolve([assistantMessage("should not run")]);
      },
    }).createSession({
      onHistoryChange: async (history) => {
        persistedLengths.push(history.length);

        if (history.length === 1) {
          firstWriteStarted.resolve();
          await releaseFirstWrite.promise;
        }

        if (history.length === 0) {
          rollbackPersisted.resolve();
        }
      },
    });

    const activeSubmit = session.submit(userText("active"));

    await firstWriteStarted.promise;
    session.kill();

    await expect(settleWithin(activeSubmit)).resolves.toBe("resolved");
    expect(calls).toBe(0);
    expect(session.getHistory()).toEqual([]);
    expect(persistedLengths).toEqual([1]);

    releaseFirstWrite.resolve();
    await rollbackPersisted.promise;
    expect(persistedLengths).toEqual([1, 0]);
  });

  it("preserves persistence failures when kill unblocks remaining writes", async () => {
    const stalledWriteStarted = createDeferred();
    const events: AgentEvent[] = [];
    const session = new Agent({
      llm: () =>
        Promise.resolve([
          assistantMessage("persisted failure"),
          assistantMessage("stalled write"),
        ]),
    }).createSession({
      onHistoryChange: async (history) => {
        if (history.length === 2) {
          throw new Error("assistant write failed");
        }

        if (history.length === 3) {
          stalledWriteStarted.resolve();
          await new Promise(() => {
            // Keep this write pending until kill() unblocks the turn.
          });
        }
      },
    });
    session.subscribe((event) => events.push(event));

    const activeSubmit = session.submit(userText("active"));

    await stalledWriteStarted.promise;
    session.kill();

    await expect(activeSubmit).rejects.toThrow("assistant write failed");
    expect(session.getHistory()).toEqual([]);
    expect(events).toEqual([
      { type: "user-text", text: "active" },
      { type: "turn-start" },
      { type: "step-start" },
      { type: "assistant-text", text: "persisted failure" },
      { type: "assistant-text", text: "stalled write" },
      { type: "step-end" },
      {
        type: "turn-error",
        message: expect.stringContaining("assistant write failed"),
      },
    ]);
  });

  it("preserves persistence failures that settle immediately after kill", async () => {
    const writeStarted = createDeferred();
    const events: AgentEvent[] = [];
    let rejectWrite: (error: Error) => void = () => {
      throw new Error("write promise was not initialized");
    };
    const session = new Agent({
      llm: () => {
        throw new Error("should not run");
      },
    }).createSession({
      onHistoryChange: () => {
        writeStarted.resolve();
        return new Promise<void>((_resolve, reject) => {
          rejectWrite = reject;
        });
      },
    });
    session.subscribe((event) => events.push(event));

    const activeSubmit = session.submit(userText("active"));

    await writeStarted.promise;
    session.kill();
    queueMicrotask(() => rejectWrite(new Error("late write failed")));

    await expect(activeSubmit).rejects.toThrow("late write failed");
    expect(session.getHistory()).toEqual([]);
    expect(events).toEqual([
      { type: "user-text", text: "active" },
      { type: "turn-start" },
      {
        type: "turn-error",
        message: expect.stringContaining("late write failed"),
      },
    ]);
  });

  it("interrupts stalled history persistence so queued input can run", async () => {
    const firstWriteStarted = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const session = new Agent({
      llm: ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    }).createSession({
      onHistoryChange: async (history) => {
        if (history.length === 1) {
          firstWriteStarted.resolve();
          await new Promise(() => {
            // Keep the first turn persistence pending until interrupt() unblocks it.
          });
        }
      },
    });
    const events: AgentEvent[] = [];
    session.subscribe((event) => events.push(event));

    const firstSubmit = session.submit(userText("first"));
    const secondSubmit = session.submit(userText("second"));

    await firstWriteStarted.promise;
    session.interrupt();
    await Promise.all([firstSubmit, secondSubmit]);

    expect(calls).toBe(1);
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("first")),
        userTextToModelMessage(userText("second")),
      ],
    ]);
    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "user-text",
      "turn-abort",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
  });

  it("rejects input if a user-text listener kills the session before queueing", async () => {
    let calls = 0;
    const session = new Agent({
      llm: () => {
        calls += 1;
        return Promise.resolve([assistantMessage("should not run")]);
      },
    }).createSession();
    const events: AgentEvent[] = [];
    session.subscribe((event) => {
      events.push(event);

      if (event.type === "user-text") {
        session.kill();
      }
    });

    await expect(session.submit(userText("kill now"))).rejects.toThrow(
      "Session killed"
    );

    expect(calls).toBe(0);
    expect(eventTypes(events)).toEqual(["user-text"]);
  });

  it("supports history hydration and returns getHistory snapshot", async () => {
    const history: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const seenHistory: ModelMessage[][] = [];
    const session = new Agent({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    }).createSession({ history });

    expect(session.getHistory()).toEqual(history);

    await session.submit(userText("remember me"));

    expect(seenHistory[0]).toEqual([
      ...history,
      userTextToModelMessage(userText("remember me")),
    ]);

    expect(session.getHistory()).toEqual([
      ...history,
      userTextToModelMessage(userText("remember me")),
      assistantMessage("DONE"),
    ]);
  });

  it("triggers onHistoryChange callback whenever history is mutated", async () => {
    const history: ModelMessage[] = [{ role: "user", content: "hello" }];
    const historicalSnapshots: ModelMessage[][] = [];
    const session = new Agent({
      llm: () => Promise.resolve([assistantMessage("hello there")]),
    }).createSession({
      history,
      onHistoryChange: (history) => {
        historicalSnapshots.push(history);
      },
    });

    await session.submit(userText("remember me"));

    expect(historicalSnapshots).toEqual([
      [...history, userTextToModelMessage(userText("remember me"))],
      [
        ...history,
        userTextToModelMessage(userText("remember me")),
        assistantMessage("hello there"),
      ],
    ]);
  });

  it("emits turn-error and rejects when onHistoryChange async callback throws or rejects", async () => {
    const events: AgentEvent[] = [];
    let llmCalls = 0;
    const session = new Agent({
      llm: () => {
        llmCalls += 1;
        return Promise.resolve([assistantMessage("hello there")]);
      },
    }).createSession({
      onHistoryChange: async () => {
        await Promise.resolve();
        throw new Error("Failed to persist database state");
      },
    });

    session.subscribe((event) => {
      events.push(event);
    });

    await expect(session.submit(userText("remember me"))).rejects.toThrow(
      "Failed to persist database state"
    );

    const errors = events.filter((event) => event.type === "turn-error");
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatchObject({
      message: expect.stringContaining(
        "onHistoryChange failed: Failed to persist database state"
      ),
      type: "turn-error",
    });
    expect(session.getHistory()).toEqual([]); // Rolled back!
    expect(llmCalls).toBe(0);
  });

  it("emits turn-error and rejects when onHistoryChange synchronous callback throws", async () => {
    const events: AgentEvent[] = [];
    let llmCalls = 0;
    const session = new Agent({
      llm: () => {
        llmCalls += 1;
        return Promise.resolve([assistantMessage("hello there")]);
      },
    }).createSession({
      onHistoryChange: () => {
        throw new Error("Synchronous database persistence failure");
      },
    });

    session.subscribe((event) => {
      events.push(event);
    });

    await expect(session.submit(userText("remember me"))).rejects.toThrow(
      "Synchronous database persistence failure"
    );

    const errors = events.filter((event) => event.type === "turn-error");
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatchObject({
      message: expect.stringContaining(
        "onHistoryChange failed: Synchronous database persistence failure"
      ),
      type: "turn-error",
    });
    expect(session.getHistory()).toEqual([]); // Rolled back!
    expect(llmCalls).toBe(0);
  });

  it("sequences onHistoryChange calls to run sequentially without overlapping", async () => {
    const activeWrites: number[] = [];
    const invocationOrder: string[] = [];
    const session = new Agent({
      llm: () => Promise.resolve([assistantMessage("hello there")]),
    }).createSession({
      onHistoryChange: async (history) => {
        const id = history.length;
        activeWrites.push(id);
        // Expect no concurrent overlapping writes - activeWrites should only have 1 element
        expect(activeWrites.length).toBe(1);

        invocationOrder.push(`start-${id}`);
        // Simulate asynchronous database delay
        await new Promise((resolve) => setTimeout(resolve, 10));
        invocationOrder.push(`end-${id}`);

        activeWrites.pop();
      },
    });

    await session.submit(userText("hi"));

    expect(invocationOrder).toEqual(["start-1", "end-1", "start-2", "end-2"]);
    expect(session.getHistory().length).toBe(2);
  });

  it("passes mutation-time snapshots to onHistoryChange", async () => {
    const userMessage = userTextToModelMessage(userText("hi"));
    const firstAssistantMessage = assistantMessage("first");
    const secondAssistantMessage = assistantMessage("second");
    const historicalSnapshots: ModelMessage[][] = [];
    const session = new Agent({
      llm: () =>
        Promise.resolve([firstAssistantMessage, secondAssistantMessage]),
    }).createSession({
      onHistoryChange: (history) => {
        historicalSnapshots.push(history);
      },
    });

    await session.submit(userText("hi"));

    expect(historicalSnapshots).toEqual([
      [userMessage],
      [userMessage, firstAssistantMessage],
      [userMessage, firstAssistantMessage, secondAssistantMessage],
    ]);
  });

  it("waits for rollback history persistence before rejecting failed turns", async () => {
    const writes: string[] = [];
    const session = new Agent({
      llm: () => Promise.reject(new Error("model failed")),
    }).createSession({
      onHistoryChange: async (history) => {
        const snapshotLength = history.length;
        writes.push(`start-${snapshotLength}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        writes.push(`end-${snapshotLength}`);
      },
    });

    await expect(session.submit(userText("hi"))).rejects.toThrow(
      "model failed"
    );

    expect(writes).toEqual(["start-1", "end-1", "start-0", "end-0"]);
    expect(session.getHistory()).toEqual([]);
  });

  it("waits for all queued history writes before rollback after persistence failure", async () => {
    const writes: string[] = [];
    const session = new Agent({
      llm: () =>
        Promise.resolve([
          assistantMessage("first"),
          assistantMessage("second"),
        ]),
    }).createSession({
      onHistoryChange: async (history) => {
        const snapshotLength = history.length;
        writes.push(`start-${snapshotLength}`);

        if (snapshotLength === 2) {
          writes.push(`fail-${snapshotLength}`);
          throw new Error("assistant write failed");
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
        writes.push(`end-${snapshotLength}`);
      },
    });

    await expect(session.submit(userText("hi"))).rejects.toThrow(
      "assistant write failed"
    );

    expect(writes).toEqual([
      "start-1",
      "end-1",
      "start-2",
      "fail-2",
      "start-3",
      "end-3",
      "start-0",
      "end-0",
    ]);
    expect(session.getHistory()).toEqual([]);
  });
});

function settleWithin(
  promise: Promise<void>,
  timeoutMs = 500
): Promise<"resolved" | "timeout" | unknown> {
  return Promise.race([
    promise.then(
      () => "resolved" as const,
      (error: unknown) => error
    ),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs);
    }),
  ]);
}
