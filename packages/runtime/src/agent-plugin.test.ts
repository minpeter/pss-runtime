import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentOptions } from "./agent";
import type { Llm } from "./llm";
import { definePlugin, sessions } from "./plugins";
import type { AgentEvent } from "./session/events";
import type { AgentRun } from "./session/run";
import type {
  CommitResult,
  ExpectedSessionVersion,
  SessionStore,
  SessionStoreCommit,
  StoredSession,
} from "./session/store/types";
import { assistantMessage } from "./test-fixtures";

const fakeLlm: Llm = () => Promise.resolve([assistantMessage("DONE")]);
const multipleSessionPersistencePattern = /multiple session persistence/i;
const removedSessionsOptionPattern = /options\.sessions was removed/i;

const collectRun = async (run: AgentRun) => {
  const events: AgentEvent[] = [];
  for await (const _event of run.events()) {
    events.push(_event);
  }
  return events;
};

const drainRun = async (run: AgentRun) => (await collectRun(run)).length;

describe("Agent plugins", () => {
  it("keeps plugin AgentOptions type fixtures reachable", () => {
    expect(pluginTypeFixtures).toHaveLength(1);
  });

  it("awaits async plugin setup before resolving Agent.create", async () => {
    const setupEvents: string[] = [];

    await Agent.create({
      llm: fakeLlm,
      plugins: [
        definePlugin({
          name: "async-test",
          async setup() {
            await Promise.resolve();
            setupEvents.push("setup-complete");
          },
        }),
      ],
    });

    expect(setupEvents).toEqual(["setup-complete"]);
  });

  it("exposes only setup-time capabilities on the plugin host", async () => {
    let hostKeys: readonly string[] = [];

    await Agent.create({
      llm: fakeLlm,
      plugins: [
        definePlugin({
          name: "host-shape",
          setup(host) {
            hostKeys = Object.keys(host).sort();
          },
        }),
      ],
    });

    expect(hostKeys).toEqual([
      "on",
      "registerSessionStore",
      "registerTools",
      "transformContext",
    ]);
  });

  it("uses sessions.custom as the Agent session store", async () => {
    const store = new RecordingStore();
    const agent = await Agent.create({
      llm: fakeLlm,
      plugins: [sessions.custom(store)],
    });

    await drainRun(await agent.session("custom").send("hello"));

    expect(store.commitCount("custom")).toBeGreaterThan(0);
    expect(readStoredHistory(store, "custom")).toEqual([
      { content: "hello", role: "user" },
      assistantMessage("DONE"),
    ]);
  });

  it("rejects multiple session persistence plugins", async () => {
    await expect(
      Agent.create({
        llm: fakeLlm,
        plugins: [sessions.inMemory(), sessions.custom(new RecordingStore())],
      })
    ).rejects.toThrow(multipleSessionPersistencePattern);
  });

  it("rejects removed legacy sessions options", async () => {
    await expect(
      Reflect.apply(Agent.create, Agent, [
        { llm: fakeLlm, sessions: { store: new RecordingStore() } },
      ])
    ).rejects.toThrow(removedSessionsOptionPattern);
  });

  it("supports plugin afterStep steering", async () => {
    let calls = 0;
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        calls += 1;
        seenHistory.push([...history]);
        return Promise.resolve([
          assistantMessage(calls === 1 ? "FIRST" : "DONE"),
        ]);
      },
      plugins: [
        definePlugin({
          name: "after-step-steer",
          setup(host) {
            host.on("afterStep", async (event) => {
              if (
                event.sessionKey === "plugin-after-step" &&
                event.stepIndex === 0 &&
                event.result === "completed"
              ) {
                await event.steer("plugin continue");
              }
            });
          },
        }),
      ],
    });

    const events = await collectRun(
      await agent.session("plugin-after-step").send("start")
    );

    expect(events).toHaveLength(10);
    expect(events).toContainEqual({
      input: { text: "plugin continue", type: "user-text" },
      placement: "step-end",
      type: "runtime-input",
    });
    expect(calls).toBe(2);
    expect(seenHistory[1]).toEqual(
      expect.arrayContaining([{ content: "plugin continue", role: "user" }])
    );
  });

  it("supports plugin beforeStep steering before the first LLM snapshot", async () => {
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
      plugins: [
        definePlugin({
          name: "before-step-steer",
          setup(host) {
            host.on("beforeStep", async ({ sessionKey, steer, stepIndex }) => {
              if (sessionKey === "plugin-before-step" && stepIndex === 0) {
                await steer("plugin before step");
              }
            });
          },
        }),
      ],
    });

    const events = await collectRun(
      await agent.session("plugin-before-step").send("start")
    );

    expect(events).toContainEqual({
      input: { text: "plugin before step", type: "user-text" },
      placement: "step-start",
      type: "runtime-input",
    });
    expect(seenHistory).toEqual([
      [
        { content: "start", role: "user" },
        { content: "plugin before step", role: "user" },
      ],
    ]);
  });

  it("supports plugin afterTurn steering as a separate run", async () => {
    let afterTurnRun: Promise<AgentRun> | undefined;
    let afterTurnSteered = false;
    const seenHistory: ModelMessage[][] = [];
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistory.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
      plugins: [
        definePlugin({
          name: "after-turn-steer",
          setup(host) {
            host.on("afterTurn", ({ sessionKey, steer }) => {
              if (sessionKey === "plugin-after-turn" && !afterTurnSteered) {
                afterTurnSteered = true;
                afterTurnRun = steer("plugin after turn");
              }
            });
          },
        }),
      ],
    });
    const session = agent.session("plugin-after-turn");

    const firstEvents = await collectRun(await session.send("start"));
    if (!afterTurnRun) {
      throw new Error("expected plugin afterTurn steering to start a run");
    }
    const afterTurnEvents = await collectRun(await afterTurnRun);

    expect(firstEvents).not.toContainEqual({
      input: { text: "plugin after turn", type: "user-text" },
      placement: "step-end",
      type: "runtime-input",
    });
    expect(afterTurnEvents[0]).toEqual({
      text: "plugin after turn",
      type: "user-text",
    });
    expect(seenHistory[1]).toEqual([
      { content: "start", role: "user" },
      assistantMessage("DONE"),
      { content: "plugin after turn", role: "user" },
    ]);
  });
});

class RecordingStore implements SessionStore {
  readonly #commitCounts = new Map<string, number>();
  readonly #sessions = new Map<string, StoredSession>();

  commit(
    key: string,
    next: SessionStoreCommit,
    options: { expectedVersion: ExpectedSessionVersion }
  ): Promise<CommitResult> {
    const current = this.#sessions.get(key);
    const currentVersion = current?.version ?? null;
    if (options.expectedVersion !== currentVersion) {
      return Promise.resolve({ ok: false, reason: "conflict" });
    }

    const version = String(Number(current?.version ?? "0") + 1);
    this.#sessions.set(key, structuredClone({ state: next.state, version }));
    this.#commitCounts.set(key, this.commitCount(key) + 1);
    return Promise.resolve({ ok: true, version });
  }

  commitCount(key: string): number {
    return this.#commitCounts.get(key) ?? 0;
  }

  load(key: string): Promise<StoredSession | null> {
    const stored = this.#sessions.get(key);
    return Promise.resolve(stored ? structuredClone(stored) : null);
  }

  stored(key: string): StoredSession | undefined {
    const stored = this.#sessions.get(key);
    return stored ? structuredClone(stored) : undefined;
  }
}

const pluginTypeFixtureStore = new RecordingStore();
const pluginTypeFixtures: readonly AgentOptions[] = [
  {
    llm: fakeLlm,
    plugins: [sessions.custom(pluginTypeFixtureStore)],
  },
];

function readStoredHistory(
  store: RecordingStore,
  key: string
): readonly ModelMessage[] {
  const snapshot = store.stored(key)?.state;
  if (
    snapshot !== null &&
    typeof snapshot === "object" &&
    "history" in snapshot &&
    Array.isArray(snapshot.history)
  ) {
    return snapshot.history as readonly ModelMessage[];
  }

  return [];
}
