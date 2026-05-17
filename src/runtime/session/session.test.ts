import assert from "node:assert/strict";
import { Agent } from "../agent";
import type { AgentEvent, ModelHistoryItem } from "./index";
import type { Llm } from "../mock-llm";

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const firstLlmCall = createDeferred();
const seenHistory: ModelHistoryItem[][] = [];
let calls = 0;
const llm: Llm = async ({ history }) => {
  calls += 1;
  seenHistory.push([...history]);

  if (calls === 1) {
    await firstLlmCall.promise;
    return [{ type: "tool-call", toolName: "continue" }];
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
      return [{ type: "tool-call", toolName: "continue" }];
    }

    return [{ type: "assistant-text", text: "DONE" }];
  },
}).createSession();

await toolLoopSession.submit({ type: "user-text", text: "remember me" });

assert.deepEqual(toolLoopHistories, [
  [{ type: "user-text", text: "remember me" }],
  [
    { type: "user-text", text: "remember me" },
    { type: "tool-call", toolName: "continue" },
  ],
]);
assert.deepEqual(toolLoopSession.history(), [
  { type: "user-text", text: "remember me" },
  { type: "tool-call", toolName: "continue" },
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
