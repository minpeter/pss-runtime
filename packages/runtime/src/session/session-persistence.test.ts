import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../agent";
import {
  createMockLanguageModelV4,
  mockLanguageModelV4Text,
} from "../mock-language-model-v4-test-utils";
import {
  assistantMessage,
  createCallbackModel,
  createDeferred,
  eventTypes,
  userMessage,
  userText,
} from "../test-fixtures";
import type { AgentEvent } from "./events";
import { userTextToModelMessage } from "./mapping";
import {
  ConflictOnCommitStore,
  ConflictOnceStore,
  collect,
  SpyStore,
} from "./session.test-support";
import { FileSessionStore } from "./store/file";

describe("Agent session persistence", () => {
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

    const first = new Agent({
      host: { kind: "session", sessionStore: store },
      model: createMockLanguageModelV4([mockLanguageModelV4Text("stored")]),
    });
    await collect(await first.session("images").send(input));

    const secondModel = createMockLanguageModelV4([
      mockLanguageModelV4Text("DONE"),
    ]);
    const second = new Agent({
      host: { kind: "session", sessionStore: store },
      model: secondModel,
    });

    await collect(await second.session("images").send("next"));

    expect(JSON.stringify(secondModel.doGenerateCalls[0]?.prompt)).toContain(
      "remember this image"
    );
    expect(JSON.stringify(secondModel.doGenerateCalls[0]?.prompt)).toContain(
      "next"
    );
  });

  it("emits and propagates runtime input commit conflicts without using the conflicted snapshot", async () => {
    const store = new ConflictOnCommitStore();
    store.conflictOnCommit = 2;
    const seenHistory: ModelMessage[][] = [];
    const session = new Agent({
      host: { kind: "session", sessionStore: store },
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    }).session("runtime-conflict");
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

  it("uses default and explicit default session state interchangeably", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
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
    const agent = new Agent({
      model: createCallbackModel(({ history }) => {
        seenHistory[currentKey]?.push([...history]);
        return Promise.resolve([assistantMessage(`DONE ${currentKey}`)]);
      }),
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
    const agent = new Agent({
      model: createCallbackModel(async ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        if (calls === 1) {
          await firstLlmCall.promise;
        }
        return [assistantMessage(`DONE ${calls}`)];
      }),
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
    const agent = new Agent({
      host: { kind: "session", sessionStore: store },
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(`DONE ${seenHistory.length}`),
        ]);
      }),
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
    const agent = new Agent({
      host: { kind: "session", sessionStore: store },
      model: createCallbackModel(() =>
        Promise.resolve([assistantMessage("DONE")])
      ),
    });

    await collect(await agent.session("spy").send("hello"));

    expect(store.commits.length).toBeGreaterThanOrEqual(1);
    const finalCommit = store.commits.at(-1);
    expect(finalCommit?.key).toBe("spy");
    expect(finalCommit?.next.state).toEqual(
      expect.objectContaining({ history: expect.any(Array), schemaVersion: 1 })
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
    const session = new Agent({
      host: { kind: "session", sessionStore: store },
      model: createCallbackModel(({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      }),
    }).session("shared");

    expect(eventTypes(await collect(await session.send("loses")))).toContain(
      "turn-error"
    );
    await collect(await session.send("recovers"));

    expect(seenHistory).toEqual([
      [...remoteHistory, userTextToModelMessage(userText("recovers"))],
    ]);
  });
});
