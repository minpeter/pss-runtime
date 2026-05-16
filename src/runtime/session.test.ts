import assert from "node:assert/strict";
import { Agent } from "./agent";
import {
  InMemorySessionHistoryStore,
  type AgentEvent,
  type ModelHistoryItem,
  type SessionHistoryStore,
  type SessionSnapshot,
} from "./session";
import type { Llm } from "./mock-llm";

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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

const abortedTurnGate = createDeferred();
const abortedTurnHistories: ModelHistoryItem[][] = [];
let abortedTurnCalls = 0;
const abortedTurnLlm: Llm = async ({ history }) => {
  abortedTurnCalls += 1;
  abortedTurnHistories.push(history);

  if (abortedTurnCalls === 1) {
    await abortedTurnGate.promise;
    return [{ type: "tool-call", toolName: "continue" }];
  }

  return [{ type: "text", text: "queued done" }];
};
const abortedTurnSession = new Agent({ llm: abortedTurnLlm }).createSession({
  id: "aborted-turn-history",
});
const abortedFirstSubmit = abortedTurnSession.submit({
  type: "user-text",
  text: "aborted input",
});
const queuedAfterAbortSubmit = abortedTurnSession.submit({
  type: "user-text",
  text: "queued after abort",
});
abortedTurnSession.interrupt();
abortedTurnGate.resolve();
await Promise.all([abortedFirstSubmit, queuedAfterAbortSubmit]);

assert.deepEqual(abortedTurnHistories, [
  [{ type: "user-text", text: "aborted input" }],
  [
    { type: "user-text", text: "aborted input" },
    { type: "user-text", text: "queued after abort" },
  ],
]);
assert.deepEqual(
  abortedTurnSession.snapshot().modelHistory.map((record) => record.item),
  [
    { type: "user-text", text: "aborted input" },
    { type: "user-text", text: "queued after abort" },
    { type: "assistant-text", text: "queued done" },
  ],
);

const activeSaveGate = createDeferred();
const activeSaveStore = new InMemorySessionHistoryStore();
const activeSaveLlm: Llm = async () => {
  await activeSaveGate.promise;
  return [{ type: "text", text: "active done" }];
};
const activeSaveSession = new Agent({
  historyStore: activeSaveStore,
  llm: activeSaveLlm,
}).createSession({ id: "active-save" });
const activeSaveFirstSubmit = activeSaveSession.submit({
  type: "user-text",
  text: "active input",
});
const activeSaveQueuedSubmit = activeSaveSession.submit({
  type: "user-text",
  text: "queued while active",
});
await delay(0);

assert.doesNotThrow(() =>
  new Agent({ llm: activeSaveLlm }).createSession({
    id: "active-save",
    snapshot: activeSaveSession.snapshot(),
  }),
);
const activeSavedSnapshot = await activeSaveStore.load("active-save");
assert.ok(activeSavedSnapshot);
assert.doesNotThrow(() =>
  new Agent({ llm: activeSaveLlm }).createSession({
    id: "active-save",
    snapshot: activeSavedSnapshot,
  }),
);

activeSaveGate.resolve();
await Promise.all([activeSaveFirstSubmit, activeSaveQueuedSubmit]);

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

const historySession = new Agent({ llm: historyLlm }).createSession({
  id: "history-test",
});
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
const toolCallSequence = fullSnapshot.events.find(
  (record) => record.event.type === "tool-call",
)?.sequence;
assert.ok(toolCallSequence);

assert.throws(
  () => historySession.viewAt(-1),
  /Invalid history sequence -1/,
);
assert.throws(
  () => historySession.viewAt(1.5),
  /Invalid history sequence 1.5/,
);

const toolCallView = historySession.viewAt(toolCallSequence);
assert.deepEqual(
  toolCallView.events.map((record) => record.event.type),
  ["user-text", "turn-start", "step-start", "assistant-text", "tool-call"],
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

assert.throws(
  () =>
    new Agent({ llm: historyLlm }).createSession({
      id: "history-test",
      snapshot: { ...fullSnapshot, nextSequence: 0 },
    }),
  /Invalid snapshot nextSequence: 0/,
);
assert.throws(
  () =>
    new Agent({ llm: historyLlm }).createSession({
      id: "history-test",
      snapshot: {
        ...fullSnapshot,
        events: [{ ...fullSnapshot.events[0]!, sequence: 0 }],
      },
    }),
  /Invalid events sequence: 0/,
);
assert.throws(
  () =>
    new Agent({ llm: historyLlm }).createSession({
      id: "history-test",
      snapshot: {
        ...fullSnapshot,
        modelHistory: [
          {
            ...fullSnapshot.modelHistory[0]!,
            sequence: fullSnapshot.nextSequence,
          },
        ],
      },
    }),
  new RegExp(`Invalid modelHistory sequence: ${fullSnapshot.nextSequence}`),
);
assert.throws(
  () =>
    new Agent({ llm: historyLlm }).createSession({
      id: "history-test",
      snapshot: {
        ...fullSnapshot,
        events: [
          {
            event: { type: "unknown" } as unknown as AgentEvent,
            sequence: 1,
          },
        ],
      },
    }),
  /Invalid agent event type: unknown/,
);
assert.throws(
  () =>
    new Agent({ llm: historyLlm }).createSession({
      id: "history-test",
      snapshot: null as unknown as SessionSnapshot,
    }),
  /Invalid session snapshot: expected an object/,
);
assert.throws(
  () =>
    new Agent({ llm: historyLlm }).createSession({
      id: "history-test",
      snapshot: {
        ...fullSnapshot,
        events: [null as never],
      },
    }),
  /Invalid events sequence: undefined/,
);
assert.throws(
  () =>
    new Agent({ llm: historyLlm }).createSession({
      id: "history-test",
      snapshot: {
        ...fullSnapshot,
        events: [
          { sequence: 1, event: { type: "user-text", text: "real user" } },
          { sequence: 2, event: { type: "step-start" } },
        ],
        modelHistory: [
          {
            sequence: 2,
            item: { type: "assistant-text", text: "ghost assistant" },
          },
        ],
        nextSequence: 3,
      },
    }),
  /Invalid modelHistory: does not match event replay/,
);
assert.throws(
  () =>
    new Agent({ llm: historyLlm }).createSession({
      id: "history-test",
      snapshot: {
        ...fullSnapshot,
        events: [{ sequence: 1, event: { type: "turn-start" } }],
        modelHistory: [],
        nextSequence: 2,
      },
    }),
  /Invalid events: turn-start at sequence 1 has no pending user input/,
);

const restoredPendingHistory: ModelHistoryItem[][] = [];
let restoredPendingCalls = 0;
const restoredPendingLlm: Llm = async ({ history }) => {
  restoredPendingCalls += 1;
  restoredPendingHistory.push(history);

  return [
    {
      type: "text",
      text: restoredPendingCalls === 1 ? "old done" : "new done",
    },
  ];
};
const restoredPendingSession = new Agent({
  llm: restoredPendingLlm,
}).createSession({
  id: "restore-pending",
  snapshot: {
    events: [
      { event: { type: "user-text", text: "old pending" }, sequence: 1 },
    ],
    modelHistory: [],
    nextSequence: 2,
    sessionId: "restore-pending",
    version: "pss-session-v1",
  },
});

await restoredPendingSession.submit({
  type: "user-text",
  text: "new input",
});

assert.equal(restoredPendingCalls, 2);
assert.deepEqual(restoredPendingHistory, [
  [{ type: "user-text", text: "old pending" }],
  [
    { type: "user-text", text: "old pending" },
    { type: "assistant-text", text: "old done" },
    { type: "user-text", text: "new input" },
  ],
]);
assert.doesNotThrow(() =>
  new Agent({ llm: restoredPendingLlm }).createSession({
    id: "restore-pending",
    snapshot: restoredPendingSession.snapshot(),
  }),
);

const mutableInputGate = createDeferred();
let mutableInputCalls = 0;
const mutableInputLlm: Llm = async ({ history }) => {
  mutableInputCalls += 1;
  const textHistory = history.filter((item) => item.type !== "tool-call");
  const lastText = textHistory.at(-1)?.text;

  if (mutableInputCalls === 1) {
    await mutableInputGate.promise;
  }

  return [{ type: "text", text: `done ${lastText}` }];
};
const mutableInputSession = new Agent({ llm: mutableInputLlm }).createSession({
  id: "mutable-input",
});
const mutableEvents: AgentEvent[] = [];
mutableInputSession.subscribe((event) => mutableEvents.push(event));

const blockingInput = { type: "user-text" as const, text: "blocking" };
const mutableInput = { type: "user-text" as const, text: "original" };
const blockingSubmit = mutableInputSession.submit(blockingInput);
const mutableSubmit = mutableInputSession.submit(mutableInput);
mutableInput.text = "mutated";
mutableInputGate.resolve();
await Promise.all([blockingSubmit, mutableSubmit]);

assert.deepEqual(
  mutableEvents.filter((event) => event.type === "user-text"),
  [
    { type: "user-text", text: "blocking" },
    { type: "user-text", text: "original" },
  ],
);
assert.deepEqual(
  mutableInputSession.snapshot().modelHistory.map((record) => record.item),
  [
    { type: "user-text", text: "blocking" },
    { type: "assistant-text", text: "done blocking" },
    { type: "user-text", text: "original" },
    { type: "assistant-text", text: "done original" },
  ],
);
assert.doesNotThrow(() =>
  new Agent({ llm: mutableInputLlm }).createSession({
    id: "mutable-input",
    snapshot: mutableInputSession.snapshot(),
  }),
);

const listenerMutationGate = createDeferred();
let listenerMutationCalls = 0;
const listenerMutationLlm: Llm = async () => {
  listenerMutationCalls += 1;

  if (listenerMutationCalls === 1) {
    await listenerMutationGate.promise;
  }

  return [{ type: "text", text: "listener-safe" }];
};
const listenerMutationSession = new Agent({
  llm: listenerMutationLlm,
}).createSession({ id: "listener-mutation" });
listenerMutationSession.subscribe((event) => {
  if (event.type === "user-text" || event.type === "assistant-text") {
    event.text = "listener-mutated";
  }
});

const firstListenerSubmit = listenerMutationSession.submit({
  type: "user-text",
  text: "first listener input",
});
const secondListenerSubmit = listenerMutationSession.submit({
  type: "user-text",
  text: "second listener input",
});
listenerMutationGate.resolve();
await Promise.all([firstListenerSubmit, secondListenerSubmit]);

assert.deepEqual(
  listenerMutationSession.snapshot().events.map((record) => record.event),
  [
    { type: "user-text", text: "first listener input" },
    { type: "turn-start" },
    { type: "step-start" },
    { type: "user-text", text: "second listener input" },
    { type: "assistant-text", text: "listener-safe" },
    { type: "step-end" },
    { type: "turn-end" },
    { type: "turn-start" },
    { type: "step-start" },
    { type: "assistant-text", text: "listener-safe" },
    { type: "step-end" },
    { type: "turn-end" },
  ],
);
assert.deepEqual(
  listenerMutationSession.snapshot().modelHistory.map((record) => record.item),
  [
    { type: "user-text", text: "first listener input" },
    { type: "assistant-text", text: "listener-safe" },
    { type: "user-text", text: "second listener input" },
    { type: "assistant-text", text: "listener-safe" },
  ],
);
assert.doesNotThrow(() =>
  new Agent({ llm: listenerMutationLlm }).createSession({
    id: "listener-mutation",
    snapshot: listenerMutationSession.snapshot(),
  }),
);

const historyStore = new InMemorySessionHistoryStore();
const persistedSession = new Agent({
  historyStore,
  llm: async () => [{ type: "text", text: "stored" }],
}).createSession({ id: "persisted" });

await persistedSession.submit({ type: "user-text", text: "persist this" });

const persistedSnapshot = await historyStore.load("persisted");
assert.deepEqual(
  persistedSnapshot?.events.map((record) => record.event.type),
  [
    "user-text",
    "turn-start",
    "step-start",
    "assistant-text",
    "step-end",
    "turn-end",
  ],
);
assert.deepEqual(
  persistedSnapshot?.modelHistory.map((record) => record.item),
  [
    { type: "user-text", text: "persist this" },
    { type: "assistant-text", text: "stored" },
  ]
);

let delayedSaveCalls = 0;
let delayedSavedSnapshot: SessionSnapshot | undefined;
const delayedStore: SessionHistoryStore = {
  async load() {
    return delayedSavedSnapshot;
  },
  async save(snapshot) {
    delayedSaveCalls += 1;

    if (delayedSaveCalls === 1) {
      await delay(50);
    }

    delayedSavedSnapshot = structuredClone(snapshot);
  },
};
const delayedSession = new Agent({
  historyStore: delayedStore,
  llm: async () => [{ type: "text", text: "stored after delay" }],
}).createSession({ id: "delayed" });

await delayedSession.submit({ type: "user-text", text: "save in order" });
await delay(80);

assert.equal(delayedSaveCalls, 2);
assert.deepEqual(
  delayedSavedSnapshot?.events.map((record) => record.event.type),
  [
    "user-text",
    "turn-start",
    "step-start",
    "assistant-text",
    "step-end",
    "turn-end",
  ],
);
