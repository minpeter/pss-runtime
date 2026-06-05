import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { Agent } from "./agent";
import { definePlugin, sessions } from "./plugins";
import type { AgentEvent } from "./session/events";
import type {
  CommitResult,
  ExpectedSessionVersion,
  SessionStore,
  SessionStoreCommit,
  StoredSession,
} from "./session/store/types";
import { assistantMessage } from "./test-fixtures";

describe("plugin context transforms", () => {
  it("changes model-facing history without changing persisted history", async () => {
    const seenHistories: ModelMessage[][] = [];
    const store = new RecordingStore();
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistories.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
      plugins: [
        sessions.custom(store),
        definePlugin({
          name: "memory-context",
          setup(host) {
            host.transformContext(({ history, sessionKey }) => [
              {
                content: `context for ${sessionKey}`,
                role: "system",
              },
              ...history,
            ]);
          },
        }),
      ],
    });

    await drainRun(await agent.session("ctx").send("hello"));

    expect(seenHistories).toEqual([
      [
        { content: "context for ctx", role: "system" },
        { content: "hello", role: "user" },
      ],
    ]);
    expect(readStoredHistory(store, "ctx")).toEqual([
      { content: "hello", role: "user" },
      assistantMessage("DONE"),
    ]);
  });

  it("emits a turn error when a transform fails", async () => {
    const agent = await Agent.create({
      llm: () => Promise.resolve([assistantMessage("unreachable")]),
      plugins: [
        definePlugin({
          name: "broken-context",
          setup(host) {
            host.transformContext(() => {
              throw new Error("context failed");
            });
          },
        }),
      ],
    });

    const events = await collectEvents(await agent.send("hello"));

    expect(events).toContainEqual({
      message: "context failed",
      type: "turn-error",
    });
  });

  it("appends plugin overlays after context transforms without persisting them", async () => {
    const seenHistories: ModelMessage[][] = [];
    const transformSeenHistories: ModelMessage[][] = [];
    const store = new RecordingStore();
    const agent = await Agent.create({
      llm: ({ history }) => {
        seenHistories.push([...history]);
        return Promise.resolve([assistantMessage("DONE")]);
      },
      plugins: [
        sessions.custom(store),
        definePlugin({
          name: "context-transform",
          setup(host) {
            host.transformContext(({ history }) => {
              transformSeenHistories.push([...history]);
              return [
                {
                  content: "transformed context",
                  role: "system",
                },
                ...history,
              ];
            });
          },
        }),
        definePlugin({
          name: "ephemeral-overlay",
          setup(host) {
            host.on("step.before", async ({ overlay }) => {
              await overlay("model-only overlay");
            });
          },
        }),
      ],
    });

    const events = await collectEvents(
      await agent.session("ctx").send("hello")
    );

    expect(transformSeenHistories).toEqual([
      [{ content: "hello", role: "user" }],
    ]);
    expect(seenHistories).toEqual([
      [
        { content: "transformed context", role: "system" },
        { content: "model-only overlay", role: "user" },
        { content: "hello", role: "user" },
      ],
    ]);
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "runtime-input" })
    );
    expect(readStoredHistory(store, "ctx")).toEqual([
      { content: "hello", role: "user" },
      assistantMessage("DONE"),
    ]);
  });
});

class RecordingStore implements SessionStore {
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
    return Promise.resolve({ ok: true, version });
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

async function collectEvents(
  run: Awaited<ReturnType<Agent["send"]>>
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }
  return events;
}

const drainRun = async (run: Awaited<ReturnType<Agent["send"]>>) => {
  let eventCount = 0;
  for await (const _event of run.events()) {
    eventCount += 1;
  }
  return eventCount;
};

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
