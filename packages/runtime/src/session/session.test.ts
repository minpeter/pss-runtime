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

  it("supports initial history hydration and returns getHistory snapshot", async () => {
    const initialHistory: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const seenHistory: ModelMessage[][] = [];
    const session = new Agent({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    }).createSession({ history: initialHistory });

    expect(session.getHistory()).toEqual(initialHistory);

    await session.submit(userText("remember me"));

    expect(seenHistory[0]).toEqual([
      ...initialHistory,
      userTextToModelMessage(userText("remember me")),
    ]);

    expect(session.getHistory()).toEqual([
      ...initialHistory,
      userTextToModelMessage(userText("remember me")),
      assistantMessage("DONE"),
    ]);
  });

  it("triggers onHistoryChange callback whenever history is mutated", async () => {
    const initialHistory: ModelMessage[] = [{ role: "user", content: "hello" }];
    const historicalSnapshots: ModelMessage[][] = [];
    const session = new Agent({
      llm: () => Promise.resolve([assistantMessage("hello there")]),
    }).createSession({
      history: initialHistory,
      onHistoryChange: (history) => {
        historicalSnapshots.push(history);
      },
    });

    await session.submit(userText("remember me"));

    expect(historicalSnapshots).toEqual([
      [...initialHistory, userTextToModelMessage(userText("remember me"))],
      [
        ...initialHistory,
        userTextToModelMessage(userText("remember me")),
        assistantMessage("hello there"),
      ],
    ]);
  });

  it("emits turn-error when onHistoryChange async callback throws or rejects", async () => {
    const events: AgentEvent[] = [];
    const session = new Agent({
      llm: () => Promise.resolve([assistantMessage("hello there")]),
    }).createSession({
      onHistoryChange: async () => {
        await Promise.resolve();
        throw new Error("Failed to persist database state");
      },
    });

    session.subscribe((event) => {
      events.push(event);
    });

    await session.submit(userText("remember me"));

    const errors = events.filter((e) => e.type === "turn-error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].type).toBe("turn-error");
    expect((errors[0] as any).message).toContain(
      "onHistoryChange failed: Failed to persist database state"
    );
  });

  it("emits turn-error when onHistoryChange synchronous callback throws", async () => {
    const events: AgentEvent[] = [];
    const session = new Agent({
      llm: () => Promise.resolve([assistantMessage("hello there")]),
    }).createSession({
      onHistoryChange: () => {
        throw new Error("Synchronous database persistence failure");
      },
    });

    session.subscribe((event) => {
      events.push(event);
    });

    await session.submit(userText("remember me"));

    const errors = events.filter((e) => e.type === "turn-error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].type).toBe("turn-error");
    expect((errors[0] as any).message).toContain(
      "onHistoryChange failed: Synchronous database persistence failure"
    );
  });
});
