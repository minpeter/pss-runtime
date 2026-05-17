import assert from "node:assert/strict";
import { Agent } from "../agent";
import type { Llm } from "../llm";
import type { AgentEvent, ModelHistoryItem, ToolCall } from "./index";

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const continueToolCall = (toolCallId: string): ToolCall => ({
  type: "tool-call",
  toolCallId,
  toolName: "continue",
  input: {},
});

const firstLlmCall = createDeferred();
const seenHistory: ModelHistoryItem[][] = [];
let calls = 0;
const llm: Llm = async ({ history }) => {
  calls += 1;
  seenHistory.push([...history]);

  if (calls === 1) {
    await firstLlmCall.promise;
    return [continueToolCall("call-interrupted-continue")];
  }

  return [{ type: "assistant-text", text: "DONE" }];
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
assert.deepEqual(seenHistory, [
  [{ type: "user-text", text: "first" }],
  [
    { type: "user-text", text: "first" },
    { type: "user-text", text: "second" },
  ],
]);
assert.deepEqual(session.history(), [
  { type: "user-text", text: "first" },
  { type: "user-text", text: "second" },
  { type: "assistant-text", text: "DONE" },
]);
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

const toolLoopHistories: ModelHistoryItem[][] = [];
let toolLoopCalls = 0;
const toolLoopSession = new Agent({
  llm: async ({ history }) => {
    toolLoopCalls += 1;
    toolLoopHistories.push([...history]);

    if (toolLoopCalls === 1) {
      return [continueToolCall("call-tool-loop-continue")];
    }

    return [{ type: "assistant-text", text: "DONE" }];
  },
}).createSession();

await toolLoopSession.submit({ type: "user-text", text: "remember me" });

assert.deepEqual(toolLoopHistories, [
  [{ type: "user-text", text: "remember me" }],
  [
    { type: "user-text", text: "remember me" },
    continueToolCall("call-tool-loop-continue"),
  ],
]);
assert.deepEqual(toolLoopSession.history(), [
  { type: "user-text", text: "remember me" },
  continueToolCall("call-tool-loop-continue"),
  { type: "assistant-text", text: "DONE" },
]);

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

const killLlmCall = createDeferred();
let killCalls = 0;
const killedSession = new Agent({
  llm: async () => {
    killCalls += 1;
    await killLlmCall.promise;
    return [{ type: "assistant-text", text: "should not render" }];
  },
}).createSession();
const killedEvents: AgentEvent[] = [];
killedSession.subscribe((event) => killedEvents.push(event));

const activeSubmit = killedSession.submit({ type: "user-text", text: "active" });
const queuedSubmit = killedSession.submit({ type: "user-text", text: "queued" });
const queuedResult = queuedSubmit.then(
  () => "resolved",
  (error: unknown) => error
);

killedSession.kill();
killLlmCall.resolve();

await activeSubmit;
const queuedError = await queuedResult;

assert.equal(killCalls, 1);
assert.ok(queuedError instanceof Error);
assert.equal(queuedError.message, "Session killed");
assert.deepEqual(killedSession.history(), [
  { type: "user-text", text: "active" },
]);
await assert.rejects(
  killedSession.submit({ type: "user-text", text: "after kill" }),
  /Session killed/
);
assert.deepEqual(killedSession.history(), [
  { type: "user-text", text: "active" },
]);
assert.deepEqual(
  killedEvents.map((event) => event.type),
  ["user-text", "turn-start", "step-start", "user-text", "turn-abort"]
);

let listenerKilledCalls = 0;
const listenerKilledSession = new Agent({
  llm: async () => {
    listenerKilledCalls += 1;
    return [{ type: "assistant-text", text: "should not run" }];
  },
}).createSession();
const listenerKilledEvents: AgentEvent[] = [];
listenerKilledSession.subscribe((event) => {
  listenerKilledEvents.push(event);

  if (event.type === "user-text") {
    listenerKilledSession.kill();
  }
});

await assert.rejects(
  listenerKilledSession.submit({ type: "user-text", text: "kill now" }),
  /Session killed/
);

assert.equal(listenerKilledCalls, 0);
assert.deepEqual(listenerKilledSession.history(), []);
assert.deepEqual(
  listenerKilledEvents.map((event) => event.type),
  ["user-text"]
);
