import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
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
import type { CommitResult, SessionStore, StoredSession } from "./store/types";

const collect = async (run: Awaited<ReturnType<Agent["send"]>>) => {
  const events: AgentEvent[] = [];
  for await (const event of run.stream()) {
    events.push(event);
  }
  return events;
};

class SpyStore implements SessionStore {
  readonly commits: Array<{
    key: string;
    next: StoredSession;
    version?: string | null;
  }> = [];
  loadCount = 0;
  loadGate?: Promise<void>;
  readonly sessions = new Map<string, StoredSession>();

  async load(key: string): Promise<StoredSession | null> {
    this.loadCount += 1;
    await this.loadGate;
    const stored = this.sessions.get(key);
    return stored ? structuredClone(stored) : null;
  }

  commit(
    key: string,
    next: StoredSession,
    options?: { expectedVersion?: string | null }
  ): Promise<CommitResult> {
    const current = this.sessions.get(key);
    const currentVersion = current?.version ?? null;
    if (
      options?.expectedVersion !== undefined &&
      options.expectedVersion !== currentVersion
    ) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    const version = String(Number(current?.version ?? 0) + 1);
    const stored = structuredClone({ state: next.state, version });
    this.commits.push({
      key,
      next: structuredClone(next),
      version: options?.expectedVersion,
    });
    this.sessions.set(key, stored);
    return Promise.resolve({ ok: true, version });
  }
}

class ConflictOnceStore extends SpyStore {
  conflictNextCommit = true;

  override commit(
    key: string,
    next: StoredSession,
    options?: { expectedVersion?: string | null }
  ): Promise<CommitResult> {
    if (this.conflictNextCommit) {
      this.conflictNextCommit = false;
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    return super.commit(key, next, options);
  }
}

describe("Agent session API", () => {
  it("agent.send accepts string input and streams one run", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });

    const events = await collect(await agent.send("hello"));

    expect(seenHistory).toEqual([[userTextToModelMessage(userText("hello"))]]);
    expect(events).toEqual([
      { type: "user-text", text: "hello" },
      { type: "turn-start" },
      { type: "step-start" },
      { type: "assistant-text", text: "DONE" },
      { type: "step-end" },
      { type: "turn-end" },
    ]);
  });

  it("agent.send accepts multipart string input without lossy joining", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });

    const events = await collect(
      await agent.send(["context", "hello"] as const)
    );

    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText(["context", "hello"]))],
    ]);
    expect(events[0]).toEqual({
      type: "user-text",
      text: ["context", "hello"],
    });
  });

  it("session.send accepts user-text events", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([]);
      },
    });

    await collect(
      await agent.session("custom").send({ type: "user-text", text: "hello" })
    );

    expect(seenHistory).toEqual([[userTextToModelMessage(userText("hello"))]]);
  });

  it("continues the model loop after a tool call result", async () => {
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = await Agent.create({
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
    });

    await collect(await agent.send("remember me"));

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

  it("emits turn-error in the run when the LLM fails", async () => {
    const agent = await Agent.create({
      llm: () => Promise.reject(new Error("model unavailable")),
    });

    const events = await collect(await agent.send("fail"));

    expect(events).toEqual([
      { type: "user-text", text: "fail" },
      { type: "turn-start" },
      { type: "step-start" },
      { type: "turn-error", message: "model unavailable" },
    ]);
  });

  it("uses default and explicit default session state interchangeably", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });

    await collect(await agent.send("first"));
    await collect(await agent.session("default").send("second"));

    expect(seenHistory[1]).toEqual([
      userTextToModelMessage(userText("first")),
      assistantMessage("DONE"),
      userTextToModelMessage(userText("second")),
    ]);
  });

  it("isolates named session keys and resumes same-key state", async () => {
    const seenHistory: Record<string, ModelMessage[][]> = { a: [], b: [] };
    let currentKey = "a";
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory[currentKey]?.push([...history]);
        return Promise.resolve([assistantMessage(`DONE ${currentKey}`)]);
      },
    });

    currentKey = "a";
    await collect(await agent.session("a").send("first a"));
    currentKey = "b";
    await collect(await agent.session("b").send("first b"));
    currentKey = "a";
    await collect(await agent.session("a").send("second a"));

    expect(seenHistory.a[1]).toEqual([
      userTextToModelMessage(userText("first a")),
      assistantMessage("DONE a"),
      userTextToModelMessage(userText("second a")),
    ]);
    expect(seenHistory.b[0]).toEqual([
      userTextToModelMessage(userText("first b")),
    ]);
  });

  it("serializes concurrent sends to the same key deterministically", async () => {
    const firstLlmCall = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = await Agent.create({
      llm: async ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        if (calls === 1) {
          await firstLlmCall.promise;
        }
        return [assistantMessage(`DONE ${calls}`)];
      },
    });

    const firstRun = await agent.session("same").send("first");
    const secondRun = await agent.session("same").send("second");
    const firstEvents = collect(firstRun);
    const secondEvents = collect(secondRun);
    firstLlmCall.resolve();

    await Promise.all([firstEvents, secondEvents]);

    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText("first"))],
      [
        userTextToModelMessage(userText("first")),
        assistantMessage("DONE 1"),
        userTextToModelMessage(userText("second")),
      ],
    ]);
  });

  it("shares the initial store load across concurrent first sends", async () => {
    const loadGate = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    const store = new SpyStore();
    store.loadGate = loadGate.promise;
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(`DONE ${seenHistory.length}`),
        ]);
      },
      sessions: { store },
    });
    const session = agent.session("race");

    const firstRun = session.send("first");
    const secondRun = session.send("second");
    expect(store.loadCount).toBe(1);
    loadGate.resolve();
    await Promise.all([collect(await firstRun), collect(await secondRun)]);

    expect(store.loadCount).toBe(1);
    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText("first"))],
      [
        userTextToModelMessage(userText("first")),
        assistantMessage("DONE 1"),
        userTextToModelMessage(userText("second")),
      ],
    ]);
  });

  it("persists versioned runtime-owned session snapshots through SessionStore", async () => {
    const store = new SpyStore();
    const agent = await Agent.create({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
      sessions: { store },
    });

    await collect(await agent.session("spy").send("hello"));

    expect(store.commits.length).toBeGreaterThanOrEqual(1);
    const finalCommit = store.commits.at(-1);
    expect(finalCommit?.key).toBe("spy");
    expect(finalCommit?.next.state).toEqual(
      expect.objectContaining({ history: expect.any(Array), schemaVersion: 1 })
    );
    expect(finalCommit?.next.state).not.toBeInstanceOf(Array);
  });

  it("refreshes stored state after commit conflicts so the handle can recover", async () => {
    const remoteHistory = [
      userTextToModelMessage(userText("remote")),
      assistantMessage("REMOTE"),
    ];
    const seenHistory: ModelMessage[][] = [];
    const store = new ConflictOnceStore();
    store.sessions.set("shared", {
      state: { history: remoteHistory, schemaVersion: 1 },
      version: "1",
    });
    const session = (
      await Agent.create({
        llm: ({ history }) => {
          seenHistory.push([...history]);
          return Promise.resolve([assistantMessage("DONE")]);
        },
        sessions: { store },
      })
    ).session("shared");

    expect(eventTypes(await collect(await session.send("loses")))).toContain(
      "turn-error"
    );
    await collect(await session.send("recovers"));

    expect(seenHistory).toEqual([
      [...remoteHistory, userTextToModelMessage(userText("recovers"))],
    ]);
  });

  it("interrupts the active run without aborting queued input", async () => {
    const firstLlmCall = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const session = (
      await Agent.create({
        llm: async ({ history }) => {
          calls += 1;
          seenHistory.push([...history]);
          if (calls === 1) {
            await firstLlmCall.promise;
          }
          return [assistantMessage("DONE")];
        },
      })
    ).session("interrupt");

    const firstRun = await session.send("first");
    const secondRun = await session.send("second");
    const firstEvents = collect(firstRun);
    const secondEvents = collect(secondRun);

    session.interrupt();
    firstLlmCall.resolve();

    expect(eventTypes(await firstEvents)).toContain("turn-abort");
    expect(eventTypes(await secondEvents)).toContain("turn-end");
    expect(calls).toBe(2);
    expect(seenHistory[1]).toEqual([
      userTextToModelMessage(userText("first")),
      userTextToModelMessage(userText("second")),
    ]);
  });
});
