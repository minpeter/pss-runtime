import assert from "node:assert/strict";
import { Agent } from "./agent";
import { InMemorySessionHistoryStore, type AgentEvent, type ModelHistoryItem } from "./session";
import type { Llm } from "./mock-llm";

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const firstLlmCall = createDeferred();
let calls = 0;
const llm: Llm = async () => {
  calls += 1;

  if (calls === 1) {
    await firstLlmCall.promise;
    return [{ type: "tool-call", toolName: "continue" }];
  }

  return [{ type: "text", text: "DONE" }];
};

const session = new Agent({ llm }).createSession();
const events: AgentEvent[] = [];
session.subscribe((event) => events.push(event));

const firstSubmit = session.submit({ type: "user-text", text: "first" });
const secondSubmit = session.submit({ type: "user-text", text: "second" });

session.interrupt();
firstLlmCall.resolve();

await Promise.all([firstSubmit, secondSubmit]);

assert.equal(calls, 2);
assert.deepEqual(
  events.map((event) => event.type),
  [
    "user-text",
    "turn-start",
    "step-start",
    "user-text",
    "turn-abort",
    "turn-start",
    "step-start",
    "assistant-text",
    "step-end",
    "turn-end",
  ]
);

const failingSession = new Agent({
  llm: async () => {
    throw new Error("model unavailable");
  },
}).createSession();
const failingEvents: AgentEvent[] = [];
failingSession.subscribe((event) => failingEvents.push(event));

await assert.rejects(
  failingSession.submit({ type: "user-text", text: "fail" }),
  /model unavailable/
);

assert.deepEqual(
  failingEvents.map((event) => event.type),
  ["user-text", "turn-start", "step-start", "turn-error"]
);
assert.deepEqual(failingEvents.at(-1), {
  type: "turn-error",
  message: "model unavailable",
});

assert.deepEqual(
  session.snapshot().modelHistory.map((record) => record.item),
  [
    { type: "user-text", text: "first" },
    { type: "user-text", text: "second" },
    { type: "assistant-text", text: "DONE" },
  ]
);

const seenHistory: ModelHistoryItem[][] = [];
let historyCalls = 0;
const historyLlm: Llm = async ({ history }) => {
  historyCalls += 1;
  seenHistory.push(history);

  if (historyCalls === 1) {
    return [
      { type: "text", text: "Looking it up." },
      { type: "tool-call", toolName: "continue" },
    ];
  }

  return [{ type: "text", text: "DONE" }];
};

const historySession = new Agent({ llm: historyLlm }).createSession({ id: "history-test" });
await historySession.submit({ type: "user-text", text: "remember me" });

assert.deepEqual(seenHistory, [
  [{ type: "user-text", text: "remember me" }],
  [
    { type: "user-text", text: "remember me" },
    { type: "assistant-text", text: "Looking it up." },
    { type: "tool-call", toolName: "continue" },
  ],
]);

const fullSnapshot = historySession.snapshot();
const toolCallSequence = fullSnapshot.events.find((record) => record.event.type === "tool-call")?.sequence;
assert.ok(toolCallSequence);

const toolCallView = historySession.history.viewAt(toolCallSequence);
assert.deepEqual(
  toolCallView.events.map((record) => record.event.type),
  ["user-text", "turn-start", "step-start", "assistant-text", "tool-call"]
);
assert.deepEqual(toolCallView.modelHistory.at(-1)?.item, {
  type: "tool-call",
  toolName: "continue",
});

const restoredSession = new Agent({ llm: historyLlm }).createSession({
  id: "history-test",
  snapshot: toolCallView,
});
assert.deepEqual(restoredSession.snapshot(), toolCallView);

const historyStore = new InMemorySessionHistoryStore();
const persistedSession = new Agent({
  historyStore,
  llm: async () => [{ type: "text", text: "stored" }],
}).createSession({ id: "persisted" });

await persistedSession.submit({ type: "user-text", text: "persist this" });

const persistedSnapshot = await historyStore.load("persisted");
assert.deepEqual(
  persistedSnapshot?.modelHistory.map((record) => record.item),
  [
    { type: "user-text", text: "persist this" },
    { type: "assistant-text", text: "stored" },
  ]
);
