import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../agent";
import { definePlugin, sessions } from "../plugins";
import {
  assistantMessage,
  createDeferred,
  eventTypes,
  toolCallPart,
  toolResultFor,
  userMessage,
  userText,
} from "../test-fixtures";
import type { AgentEvent } from "./events";
import { userTextToModelMessage } from "./mapping";
import { FileSessionStore } from "./store/file";
import type {
  CommitResult,
  SessionStore,
  SessionStoreCommit,
  StoredSession,
} from "./store/types";

const collect = async (run: Awaited<ReturnType<Agent["send"]>>) => {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
};

class SpyStore implements SessionStore {
  readonly commits: Array<{
    key: string;
    next: SessionStoreCommit;
    expectedVersion: string | null;
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
    next: SessionStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    const current = this.sessions.get(key);
    const currentVersion = current?.version ?? null;
    if (options.expectedVersion !== currentVersion) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    const version = String(Number(current?.version ?? 0) + 1);
    const stored = structuredClone({ state: next.state, version });
    this.commits.push({
      key,
      next: structuredClone(next),
      expectedVersion: options.expectedVersion,
    });
    this.sessions.set(key, stored);
    return Promise.resolve({ ok: true, version });
  }
}

class ConflictOnceStore extends SpyStore {
  conflictNextCommit = true;

  override commit(
    key: string,
    next: SessionStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    if (this.conflictNextCommit) {
      this.conflictNextCommit = false;
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    return super.commit(key, next, options);
  }
}

class ConflictOnCommitStore extends SpyStore {
  commitCount = 0;
  conflictOnCommit = 1;

  override commit(
    key: string,
    next: SessionStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    this.commitCount += 1;
    if (this.commitCount === this.conflictOnCommit) {
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

  it("calls plugin turn lifecycle around a queued turn", async () => {
    const lifecycleCalls: string[] = [];
    const agent = await Agent.create({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
      plugins: [
        definePlugin({
          name: "turn-lifecycle",
          setup(host) {
            host.on("turn.after", ({ history, input, result }) => {
              lifecycleCalls.push(
                `${input.type}:after:${result}:${history.length}`
              );
            });
            host.on("turn.before", ({ history, input }) => {
              lifecycleCalls.push(`${input.type}:before:${history.length}`);
            });
          },
        }),
      ],
    });

    const events = await collect(await agent.send("hello"));

    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(lifecycleCalls).toEqual([
      "user-text:before:0",
      "user-text:after:completed:2",
    ]);
  });

  it("commits successful output before turn.after failures", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = await Agent.create({
      llm: ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage(`DONE ${calls}`)]);
      },
      plugins: [
        definePlugin({
          name: "failing-after-turn",
          setup(host) {
            host.on("turn.after", () => {
              throw new Error("after turn failed");
            });
          },
        }),
      ],
    });

    try {
      const firstEvents = await collect(
        await agent.session("after-turn").send("first")
      );
      const secondEvents = await collect(
        await agent.session("after-turn").send("second")
      );

      expect(eventTypes(firstEvents)).toEqual([
        "user-text",
        "turn-start",
        "step-start",
        "assistant-text",
        "step-end",
        "turn-end",
      ]);
      expect(eventTypes(secondEvents)).toEqual([
        "user-text",
        "turn-start",
        "step-start",
        "assistant-text",
        "step-end",
        "turn-end",
      ]);
      expect(seenHistory[1]).toEqual([
        userTextToModelMessage(userText("first")),
        assistantMessage("DONE 1"),
        userTextToModelMessage(userText("second")),
      ]);
      expect(consoleError).toHaveBeenCalledWith(
        "Agent plugin turn.after handler failed:",
        expect.any(Error)
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("continues the turn but logs step.after failures", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const agent = await Agent.create({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
      plugins: [
        definePlugin({
          name: "failing-after-step",
          setup(host) {
            host.on("step.after", () => {
              throw new Error("after step failed");
            });
          },
        }),
      ],
    });

    try {
      const events = await collect(
        await agent.session("after-step").send("hi")
      );

      expect(eventTypes(events)).toEqual([
        "user-text",
        "turn-start",
        "step-start",
        "assistant-text",
        "step-end",
        "turn-end",
      ]);
      expect(consoleError).toHaveBeenCalledWith(
        "Agent plugin step.after handler failed:",
        expect.any(Error)
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("orders plugin lifecycle around runtime input windows", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const lifecycleCalls: string[] = [];
    const trace: string[] = [];
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = await Agent.create({
      llm: ({ history }) => {
        trace.push(`llm:${calls}`);
        seenHistory.push([...history]);
        calls += 1;
        return Promise.resolve([
          assistantMessage(["SEED", "FIRST", "DONE"][calls - 1] ?? "DONE"),
        ]);
      },
      plugins: [
        definePlugin({
          name: "runtime-ordering",
          setup(host) {
            host.on("step.after", ({ history, result, stepIndex }) => {
              lifecycleCalls.push(
                `step.after:${stepIndex}:${result}:${history.length}`
              );
              trace.push(`lifecycle:step.after:${stepIndex}`);
            });
            host.on("turn.after", ({ history, input, result }) => {
              lifecycleCalls.push(
                `${input.type}:turn.after:${result}:${history.length}`
              );
              trace.push("lifecycle:turn.after");
              throw new Error("after turn failed");
            });
            host.on("step.before", ({ history, stepIndex }) => {
              lifecycleCalls.push(`step.before:${stepIndex}:${history.length}`);
              trace.push(`lifecycle:step.before:${stepIndex}`);
            });
            host.on("turn.before", ({ history, input }) => {
              lifecycleCalls.push(
                `${input.type}:turn.before:${history.length}`
              );
              trace.push("lifecycle:turn.before");
            });
          },
        }),
      ],
    });
    const session = agent.session("plugin-runtime-ordering");

    await collect(await session.send("prior"));

    lifecycleCalls.length = 0;
    trace.length = 0;
    seenHistory.length = 0;

    const run = await session.send("original");
    const events: AgentEvent[] = [];
    let addedTurnStart = false;
    let addedStepStart = false;
    let addedStepEnd = false;

    for await (const event of run.events()) {
      events.push(event);
      trace.push(`event:${event.type}`);

      if (event.type === "turn-start" && !addedTurnStart) {
        addedTurnStart = true;
        await session.steer("turn runtime");
      }

      if (event.type === "step-start" && !addedStepStart) {
        addedStepStart = true;
        await session.steer("step runtime");
      }

      if (event.type === "step-end" && !addedStepEnd) {
        addedStepEnd = true;
        await session.steer("step-end runtime");
      }
    }

    const priorHistory = [
      userTextToModelMessage(userText("prior")),
      assistantMessage("SEED"),
    ];
    const firstStepHistory = [
      ...priorHistory,
      userTextToModelMessage(userText("original")),
      userTextToModelMessage(userText("turn runtime")),
      userTextToModelMessage(userText("step runtime")),
    ];
    const secondStepHistory = [
      ...firstStepHistory,
      assistantMessage("FIRST"),
      userTextToModelMessage(userText("step-end runtime")),
    ];
    const finalHistory = [...secondStepHistory, assistantMessage("DONE")];

    expect(lifecycleCalls).toEqual([
      "user-text:turn.before:2",
      "step.before:0:4",
      "step.after:0:completed:6",
      "step.before:1:7",
      "step.after:1:completed:8",
      "user-text:turn.after:completed:8",
    ]);
    expect(eventTypes(events)).toEqual([
      "user-text",
      "turn-start",
      "runtime-input",
      "step-start",
      "runtime-input",
      "assistant-text",
      "step-end",
      "runtime-input",
      "step-start",
      "assistant-text",
      "step-end",
      "turn-end",
    ]);
    expect(events).toContainEqual({
      type: "runtime-input",
      input: { type: "user-text", text: "turn runtime" },
      placement: "turn-start",
    });
    expect(events).toContainEqual({
      type: "runtime-input",
      input: { type: "user-text", text: "step runtime" },
      placement: "step-start",
    });
    expect(events).toContainEqual({
      type: "runtime-input",
      input: { type: "user-text", text: "step-end runtime" },
      placement: "step-end",
    });
    expect(seenHistory).toEqual([firstStepHistory, secondStepHistory]);
    expect(trace).toEqual([
      "lifecycle:turn.before",
      "event:user-text",
      "event:turn-start",
      "event:runtime-input",
      "lifecycle:step.before:0",
      "event:step-start",
      "event:runtime-input",
      "llm:1",
      "event:assistant-text",
      "lifecycle:step.after:0",
      "event:step-end",
      "event:runtime-input",
      "lifecycle:step.before:1",
      "event:step-start",
      "llm:2",
      "event:assistant-text",
      "lifecycle:step.after:1",
      "event:step-end",
      "lifecycle:turn.after",
      "event:turn-end",
    ]);
    expect(finalHistory).toEqual([
      ...priorHistory,
      userTextToModelMessage(userText("original")),
      userTextToModelMessage(userText("turn runtime")),
      userTextToModelMessage(userText("step runtime")),
      assistantMessage("FIRST"),
      userTextToModelMessage(userText("step-end runtime")),
      assistantMessage("DONE"),
    ]);
    consoleError.mockRestore();
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

  it("agent.send accepts JSON-serializable user content parts", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });

    const input = [
      { type: "text", text: "describe this" },
      { type: "image", image: "iVBORw0KGgo=", mediaType: "image/png" },
      {
        type: "file",
        data: { type: "text", text: "inline document" },
        filename: "note.txt",
        mediaType: "text/plain",
      },
    ] as const;
    const events = await collect(await agent.send(input));

    expect(seenHistory).toEqual([
      [
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "file", data: "iVBORw0KGgo=", mediaType: "image/png" },
            {
              type: "file",
              data: { type: "text", text: "inline document" },
              filename: "note.txt",
              mediaType: "text/plain",
            },
          ],
        },
      ],
    ]);
    expect(events[0]).toEqual({
      type: "user-message",
      content: input,
    });
  });

  it("rejects malformed multipart input before queueing", async () => {
    const agent = await Agent.create({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
    });

    await expect(
      agent.send([{ type: "image", mediaType: "image/png" }] as never)
    ).rejects.toThrow(
      'Agent input content parts must be { type: "text", text }, { type: "image", image }, or { type: "file", data, mediaType }.'
    );
  });

  it("rejects malformed explicit user-message input before queueing", async () => {
    const agent = await Agent.create({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
    });

    await expect(
      agent.send({
        type: "user-message",
        content: [{ type: "file", data: "abc" }],
      } as never)
    ).rejects.toThrow(
      'Agent input content parts must be { type: "text", text }, { type: "image", image }, or { type: "file", data, mediaType }.'
    );
  });

  it("file session store preserves image content parts across reload", async () => {
    const input = userMessage([
      { type: "text", text: "remember this image" },
      {
        type: "image",
        image: "data:image/png;base64,ZmFrZQ==",
        mediaType: "image/png",
      },
      {
        type: "file",
        data: { type: "text", text: "inline note" },
        filename: "note.txt",
        mediaType: "text/plain",
      },
    ]);
    const directory = await mkdtemp(join(tmpdir(), "pss-runtime-image-store-"));
    const store = new FileSessionStore(directory);

    const first = await Agent.create({
      llm: () => Promise.resolve([assistantMessage("stored")]),
      plugins: [sessions.custom(store)],
    });
    await collect(await first.session("images").send(input));

    const seenHistory: ModelMessage[][] = [];
    const second = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
      plugins: [sessions.custom(store)],
    });

    await collect(await second.session("images").send("next"));

    expect(seenHistory).toEqual([
      [
        {
          role: "user",
          content: [
            { type: "text", text: "remember this image" },
            {
              type: "file",
              data: "data:image/png;base64,ZmFrZQ==",
              mediaType: "image/png",
            },
            {
              type: "file",
              data: { type: "text", text: "inline note" },
              filename: "note.txt",
              mediaType: "text/plain",
            },
          ],
        },
        assistantMessage("stored"),
        userTextToModelMessage(userText("next")),
      ],
    ]);
  });

  it("session.send accepts user-message events", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([]);
      },
    });

    await collect(
      await agent.session("custom").send(
        userMessage([
          { type: "text", text: "summarize" },
          { type: "image", image: "iVBORw0KGgo=" },
        ])
      )
    );

    expect(seenHistory).toEqual([
      [
        {
          role: "user",
          content: [
            { type: "text", text: "summarize" },
            { type: "file", data: "iVBORw0KGgo=", mediaType: "image" },
          ],
        },
      ],
    ]);
  });

  it("persists user-message metadata as model provider options", async () => {
    const store = new SpyStore();
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
      plugins: [sessions.custom(store)],
    });

    const metadata = {
      openai: { cacheControl: { type: "ephemeral" } },
    };
    const input = {
      content: [{ type: "text", text: "cache this turn" }],
      metadata,
      type: "user-message",
    } as const;

    const events = await collect(await agent.session("metadata").send(input));

    expect(events[0]).toEqual(input);
    expect(seenHistory[0]?.[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "cache this turn" }],
      providerOptions: metadata,
    });
    expect(store.sessions.get("metadata")?.state).toEqual(
      expect.objectContaining({
        history: expect.arrayContaining([
          {
            role: "user",
            content: [{ type: "text", text: "cache this turn" }],
            providerOptions: metadata,
          },
        ]),
      })
    );
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

  it("active session.steer at step-end continues the current turn with appended user input", async () => {
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const agent = await Agent.create({
      llm: ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(calls === 1 ? "This could be final." : "DONE"),
        ]);
      },
    });
    const session = agent.session("step-end-steer");
    const run = await session.send("initial user");
    const events: AgentEvent[] = [];
    let injected = false;

    for await (const event of run.events()) {
      events.push(event);
      if (event.type === "step-end" && !injected) {
        injected = true;
        await session.steer("extra");
      }
    }

    expect(seenHistory).toEqual([
      [userTextToModelMessage(userText("initial user"))],
      [
        userTextToModelMessage(userText("initial user")),
        assistantMessage("This could be final."),
        userTextToModelMessage(userText("extra")),
      ],
    ]);
    expect(events).toEqual([
      { type: "user-text", text: "initial user" },
      { type: "turn-start" },
      { type: "step-start" },
      { type: "assistant-text", text: "This could be final." },
      { type: "step-end" },
      {
        type: "runtime-input",
        input: { type: "user-text", text: "extra" },
        placement: "step-end",
      },
      { type: "step-start" },
      { type: "assistant-text", text: "DONE" },
      { type: "step-end" },
      { type: "turn-end" },
    ]);
  });

  it("active session.steer at turn-start and step-start is visible before the first LLM snapshot", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });
    const session = agent.session("early-steer");
    const run = await session.send("original");
    const events: AgentEvent[] = [];
    let addedTurnStart = false;
    let addedStepStart = false;

    for await (const event of run.events()) {
      events.push(event);
      if (event.type === "turn-start" && !addedTurnStart) {
        addedTurnStart = true;
        await session.steer("turn runtime");
      }
      if (event.type === "step-start" && !addedStepStart) {
        addedStepStart = true;
        await session.steer("step runtime");
      }
    }

    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("original")),
        userTextToModelMessage(userText("turn runtime")),
        userTextToModelMessage(userText("step runtime")),
      ],
    ]);
    expect(events).toEqual([
      { type: "user-text", text: "original" },
      { type: "turn-start" },
      {
        type: "runtime-input",
        input: { type: "user-text", text: "turn runtime" },
        placement: "turn-start",
      },
      { type: "step-start" },
      {
        type: "runtime-input",
        input: { type: "user-text", text: "step runtime" },
        placement: "step-start",
      },
      { type: "assistant-text", text: "DONE" },
      { type: "step-end" },
      { type: "turn-end" },
    ]);
  });

  it("drains plugin steering at turn-start, step-start, and step-end but not turn.after", async () => {
    const seenHistory: ModelMessage[][] = [];
    let turnAfterRun: Promise<Awaited<ReturnType<Agent["send"]>>> | undefined;
    let turnAfterSteered = false;
    let step = 0;
    const agent = await Agent.create({
      llm: ({ history }) => {
        step += 1;
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(step === 1 ? "This could be final." : "DONE"),
        ]);
      },
      plugins: [
        definePlugin({
          name: "steering-lifecycle",
          setup(host) {
            host.on("step.after", async ({ steer, stepIndex }) => {
              if (stepIndex === 0) {
                await steer("after step steer");
              }
            });
            host.on("turn.after", ({ steer }) => {
              if (!turnAfterSteered) {
                turnAfterSteered = true;
                turnAfterRun = steer("after turn steer");
              }
            });
            host.on("step.before", async ({ steer, stepIndex }) => {
              if (stepIndex === 0) {
                await steer("before step steer");
              }
            });
            host.on("turn.before", async ({ steer }) => {
              await steer("before turn steer");
            });
          },
        }),
      ],
    });
    const session = agent.session("plugin-steer");

    const events = await collect(await session.send("original"));

    expect(events).toContainEqual({
      input: { type: "user-text", text: "before turn steer" },
      placement: "turn-start",
      type: "runtime-input",
    });
    expect(events).toContainEqual({
      input: { type: "user-text", text: "before step steer" },
      placement: "step-start",
      type: "runtime-input",
    });
    expect(events).toContainEqual({
      input: { type: "user-text", text: "after step steer" },
      placement: "step-end",
      type: "runtime-input",
    });
    expect(events).not.toContainEqual({
      input: { type: "user-text", text: "after turn steer" },
      placement: "step-end",
      type: "runtime-input",
    });
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("original")),
        userTextToModelMessage(userText("before turn steer")),
        userTextToModelMessage(userText("before step steer")),
      ],
      [
        userTextToModelMessage(userText("original")),
        userTextToModelMessage(userText("before turn steer")),
        userTextToModelMessage(userText("before step steer")),
        assistantMessage("This could be final."),
        userTextToModelMessage(userText("after step steer")),
      ],
    ]);
    if (!turnAfterRun) {
      throw new Error("expected turn.after steer to start a new run");
    }
    const turnAfterEvents = await collect(await turnAfterRun);
    expect(turnAfterEvents[0]).toEqual({
      text: "after turn steer",
      type: "user-text",
    });
  });

  it("active session.steer preserves FIFO order for multiple additions in one window", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });
    const session = agent.session("steer-fifo");
    const run = await session.send("initial");
    const runtimeInputs: AgentEvent[] = [];
    let added = false;

    for await (const event of run.events()) {
      if (event.type === "step-start" && !added) {
        added = true;
        await session.steer("first");
        await session.steer("second");
      }
      if (event.type === "runtime-input") {
        runtimeInputs.push(event);
      }
    }

    expect(runtimeInputs).toEqual([
      {
        type: "runtime-input",
        input: { type: "user-text", text: "first" },
        placement: "step-start",
      },
      {
        type: "runtime-input",
        input: { type: "user-text", text: "second" },
        placement: "step-start",
      },
    ]);
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("initial")),
        userTextToModelMessage(userText("first")),
        userTextToModelMessage(userText("second")),
      ],
    ]);
  });

  it("active session.steer preserves FIFO order for concurrent additions in one window", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });
    const session = agent.session("steer-concurrent-fifo");
    const run = await session.send("initial");
    const runtimeInputs: AgentEvent[] = [];
    let added = false;

    for await (const event of run.events()) {
      if (event.type === "step-start" && !added) {
        added = true;
        await Promise.all([
          session.steer("first"),
          session.steer("second"),
          session.steer("third"),
        ]);
      }
      if (event.type === "runtime-input") {
        runtimeInputs.push(event);
      }
    }

    expect(runtimeInputs).toEqual([
      {
        type: "runtime-input",
        input: { type: "user-text", text: "first" },
        placement: "step-start",
      },
      {
        type: "runtime-input",
        input: { type: "user-text", text: "second" },
        placement: "step-start",
      },
      {
        type: "runtime-input",
        input: { type: "user-text", text: "third" },
        placement: "step-start",
      },
    ]);
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("initial")),
        userTextToModelMessage(userText("first")),
        userTextToModelMessage(userText("second")),
        userTextToModelMessage(userText("third")),
      ],
    ]);
  });

  it("keeps active session.send input as a separate turn while session.steer affects the active turn", async () => {
    const stepGate = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const session = (
      await Agent.create({
        llm: async ({ history }) => {
          calls += 1;
          seenHistory.push([...history]);
          if (calls === 1) {
            await stepGate.promise;
            return [assistantMessage("ACTIVE")];
          }
          return [assistantMessage("QUEUED")];
        },
      })
    ).session("queue-separation");
    const firstRun = await session.send("first");
    const secondRun = await session.send("second");
    const firstEvents: AgentEvent[] = [];
    let added = false;
    const firstCollecting = (async () => {
      for await (const event of firstRun.events()) {
        firstEvents.push(event);
        if (event.type === "step-start" && !added) {
          added = true;
          await session.steer("extra");
          stepGate.resolve();
        }
      }
    })();
    const secondEvents = collect(secondRun);

    await Promise.all([firstCollecting, secondEvents]);

    expect(firstEvents).toContainEqual({
      type: "runtime-input",
      input: { type: "user-text", text: "extra" },
      placement: "step-start",
    });
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("first")),
        userTextToModelMessage(userText("extra")),
      ],
      [
        userTextToModelMessage(userText("first")),
        userTextToModelMessage(userText("extra")),
        assistantMessage("ACTIVE"),
        userTextToModelMessage(userText("second")),
      ],
    ]);
  });

  it("normalizes multipart image and file session.steer input like session.send", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });
    const input = [
      { type: "text", text: "describe this" },
      { type: "image", image: "iVBORw0KGgo=", mediaType: "image/png" },
      {
        type: "file",
        data: { type: "text", text: "inline document" },
        filename: "note.txt",
        mediaType: "text/plain",
      },
    ] as const;
    const session = agent.session("multipart-steer");
    const run = await session.send("initial");
    const runtimeInputs: AgentEvent[] = [];
    let added = false;

    for await (const event of run.events()) {
      if (event.type === "step-start" && !added) {
        added = true;
        await session.steer(input);
      }
      if (event.type === "runtime-input") {
        runtimeInputs.push(event);
      }
    }

    expect(runtimeInputs).toEqual([
      {
        type: "runtime-input",
        input: { type: "user-message", content: input },
        placement: "step-start",
      },
    ]);
    expect(seenHistory).toEqual([
      [
        userTextToModelMessage(userText("initial")),
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "file", data: "iVBORw0KGgo=", mediaType: "image/png" },
            {
              type: "file",
              data: { type: "text", text: "inline document" },
              filename: "note.txt",
              mediaType: "text/plain",
            },
          ],
        },
      ],
    ]);
  });

  it("idle session.steer starts a new run after turn-end", async () => {
    let calls = 0;
    const agent = await Agent.create({
      llm: () => {
        calls += 1;
        return Promise.resolve([assistantMessage("DONE")]);
      },
    });
    const session = agent.session("idle-steer-after-turn-end");
    const run = await session.send("initial");

    await collect(run);

    await collect(await session.steer("late"));
    expect(calls).toBe(2);
  });

  it("idle session.steer starts a new run after model turn-error", async () => {
    let calls = 0;
    const agent = await Agent.create({
      llm: () => {
        calls += 1;
        return Promise.reject(new Error("model unavailable"));
      },
    });
    const session = agent.session("idle-steer-after-turn-error");
    const run = await session.send("initial");

    expect(eventTypes(await collect(run))).toContain("turn-error");

    expect(eventTypes(await collect(await session.steer("late")))).toContain(
      "turn-error"
    );
    expect(calls).toBe(2);
  });

  it("idle session.steer starts a new run after interrupt turn-abort", async () => {
    const llmStarted = createDeferred();
    const llmGate = createDeferred();
    const session = (
      await Agent.create({
        llm: async () => {
          llmStarted.resolve();
          await llmGate.promise;
          return [assistantMessage("DONE")];
        },
      })
    ).session("interrupt-terminal");
    const run = await session.send("initial");
    const events = collect(run);

    await llmStarted.promise;
    session.interrupt();
    llmGate.resolve();

    expect(eventTypes(await events)).toContain("turn-abort");
    expect(eventTypes(await collect(await session.steer("late")))).toContain(
      "turn-end"
    );
  });

  it("rejects runtime input after kill and settles queued runs", async () => {
    const llmStarted = createDeferred();
    const llmGate = createDeferred();
    const session = (
      await Agent.create({
        llm: async () => {
          llmStarted.resolve();
          await llmGate.promise;
          return [assistantMessage("DONE")];
        },
      })
    ).session("kill-terminal");
    const firstRun = await session.send("first");
    const secondRun = await session.send("second");
    const firstEvents = collect(firstRun);
    const secondEvents = collect(secondRun);

    await llmStarted.promise;
    session.kill();
    llmGate.resolve();

    expect(eventTypes(await firstEvents)).toContain("turn-abort");
    expect(eventTypes(await secondEvents)).toEqual(["user-text", "turn-error"]);
    await expect(session.steer("late")).rejects.toThrow("Session killed");
  });

  it("rejects runtime input after events return", async () => {
    const agent = await Agent.create({
      llm: () => Promise.resolve([assistantMessage("DONE")]),
    });
    const run = await agent.send("initial");
    const iterator = run.events()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "user-text", text: "initial" },
    });
    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(eventTypes(await collect(await agent.send("late")))).toContain(
      "turn-end"
    );
  });

  it("emits and propagates runtime input commit conflicts without using the conflicted snapshot", async () => {
    const store = new ConflictOnCommitStore();
    store.conflictOnCommit = 2;
    const seenHistory: ModelMessage[][] = [];
    const session = (
      await Agent.create({
        llm: ({ history }) => {
          seenHistory.push([...history]);
          return Promise.resolve([assistantMessage("DONE")]);
        },
        plugins: [sessions.custom(store)],
      })
    ).session("runtime-conflict");
    const run = await session.send("initial");
    const events: AgentEvent[] = [];
    let runtimeAdd: Promise<void> | undefined;

    for await (const event of run.events()) {
      events.push(event);
      if (event.type === "turn-start" && !runtimeAdd) {
        runtimeAdd = session.steer("conflicting runtime").then(() => undefined);
      }
    }

    await expect(runtimeAdd).resolves.toBeUndefined();
    expect(events).toContainEqual({
      type: "turn-error",
      message: 'Session "runtime-conflict" commit conflict',
    });
    expect(seenHistory).toEqual([]);
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
      plugins: [sessions.custom(store)],
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
      plugins: [sessions.custom(store)],
    });

    await collect(await agent.session("spy").send("hello"));

    expect(store.commits.length).toBeGreaterThanOrEqual(1);
    const finalCommit = store.commits.at(-1);
    expect(finalCommit?.key).toBe("spy");
    expect(finalCommit?.next.state).toEqual(
      expect.objectContaining({
        compactions: [],
        history: expect.any(Array),
        pluginState: {},
        schemaVersion: 2,
      })
    );
    expect(finalCommit?.next.state).not.toBeInstanceOf(Array);
    expect(finalCommit?.next).not.toHaveProperty("version");
    expect(store.commits[0]?.expectedVersion).toBeNull();
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
        plugins: [sessions.custom(store)],
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
    const firstLlmStarted = createDeferred();
    const seenHistory: ModelMessage[][] = [];
    let calls = 0;
    const session = (
      await Agent.create({
        llm: async ({ history }) => {
          calls += 1;
          seenHistory.push([...history]);
          if (calls === 1) {
            firstLlmStarted.resolve();
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

    await firstLlmStarted.promise;
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
