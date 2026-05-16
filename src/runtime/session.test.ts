import assert from "node:assert/strict";
import { Agent } from "./agent";
import type { AgentEvent } from "./events";
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

const firstSubmit = session.submit({ type: "user-message", text: "first" });
const secondSubmit = session.submit({ type: "user-message", text: "second" });

session.interrupt();
firstLlmCall.resolve();

await Promise.all([firstSubmit, secondSubmit]);

assert.equal(calls, 2);
assert.deepEqual(
  events.map((event) => event.type),
  [
    "user-message",
    "turn-start",
    "step-start",
    "user-message",
    "turn-abort",
    "turn-start",
    "step-start",
    "text",
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
  failingSession.submit({ type: "user-message", text: "fail" }),
  /model unavailable/
);

assert.deepEqual(
  failingEvents.map((event) => event.type),
  ["user-message", "turn-start", "step-start", "turn-error"]
);
assert.deepEqual(failingEvents.at(-1), {
  type: "turn-error",
  message: "model unavailable",
});
