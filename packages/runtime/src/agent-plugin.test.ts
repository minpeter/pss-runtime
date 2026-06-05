import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentOptions } from "./agent";
import type { Llm } from "./llm";
import { definePlugin, sessions } from "./plugins";
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

const drainRun = async (run: Awaited<ReturnType<Agent["send"]>>) => {
  let eventCount = 0;
  for await (const _event of run.events()) {
    eventCount += 1;
  }
  return eventCount;
};

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
