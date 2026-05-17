import assert from "node:assert/strict";
import { Agent } from "../agent";
import type { Llm } from "../llm";
import type {
  AgentEvent,
  AssistantMessage,
  ModelHistoryItem,
  ToolCall,
  ToolMessage,
  UserMessage,
} from "./index";

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

const userMessage = (content: string): UserMessage => ({ role: "user", content });

const assistantMessage = (
  content: AssistantMessage["content"]
): AssistantMessage => ({
  role: "assistant",
  content,
});

const continueToolResult = (toolCall: ToolCall): ToolMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      output: { type: "json", value: {} },
    },
  ],
});

const eventKind = (event: AgentEvent): string =>
  "role" in event ? event.role : event.type;

const firstLlmCall = createDeferred();
const seenHistory: ModelHistoryItem[][] = [];
let calls = 0;
const llm: Llm = async ({ history }) => {
  calls += 1;
  seenHistory.push([...history]);

  if (calls === 1) {
    await firstLlmCall.promise;
    const toolCall = continueToolCall("call-interrupted-continue");
    return [assistantMessage([toolCall]), continueToolResult(toolCall)];
  }

  return [assistantMessage("DONE")];
};

const session = new Agent({ llm }).createSession();
const events: AgentEvent[] = [];
session.subscribe((event) => events.push(event));

const firstSubmit = session.submit(userMessage("first"));
const secondSubmit = session.submit(userMessage("second"));

session.interrupt();
firstLlmCall.resolve();

await Promise.all([firstSubmit, secondSubmit]);

assert.equal(calls, 2);
assert.deepEqual(seenHistory, [
  [userMessage("first")],
  [
    userMessage("first"),
    userMessage("second"),
  ],
]);
assert.deepEqual(session.history(), [
  userMessage("first"),
  userMessage("second"),
  assistantMessage("DONE"),
]);
assert.deepEqual(
  events.map(eventKind),
  [
    "user",
    "turn-start",
    "step-start",
    "user",
    "turn-abort",
    "turn-start",
    "step-start",
    "assistant",
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
      const toolCall = continueToolCall("call-tool-loop-continue");
      return [assistantMessage([toolCall]), continueToolResult(toolCall)];
    }

    return [assistantMessage("DONE")];
  },
}).createSession();

await toolLoopSession.submit(userMessage("remember me"));

const toolLoopCall = continueToolCall("call-tool-loop-continue");

assert.deepEqual(toolLoopHistories, [
  [userMessage("remember me")],
  [
    userMessage("remember me"),
    assistantMessage([toolLoopCall]),
    continueToolResult(toolLoopCall),
  ],
]);
assert.deepEqual(toolLoopSession.history(), [
  userMessage("remember me"),
  assistantMessage([toolLoopCall]),
  continueToolResult(toolLoopCall),
  assistantMessage("DONE"),
]);

const failingSession = new Agent({
  llm: async () => {
    throw new Error("model unavailable");
  },
}).createSession();
const failingEvents: AgentEvent[] = [];
failingSession.subscribe((event) => failingEvents.push(event));

await assert.rejects(
  failingSession.submit(userMessage("fail")),
  /model unavailable/
);

assert.deepEqual(
  failingEvents.map(eventKind),
  ["user", "turn-start", "step-start", "turn-error"]
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
    return [assistantMessage("should not render")];
  },
}).createSession();
const killedEvents: AgentEvent[] = [];
killedSession.subscribe((event) => killedEvents.push(event));

const activeSubmit = killedSession.submit(userMessage("active"));
const queuedSubmit = killedSession.submit(userMessage("queued"));
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
  userMessage("active"),
]);
await assert.rejects(
  killedSession.submit(userMessage("after kill")),
  /Session killed/
);
assert.deepEqual(killedSession.history(), [
  userMessage("active"),
]);
assert.deepEqual(
  killedEvents.map(eventKind),
  ["user", "turn-start", "step-start", "user", "turn-abort"]
);

let listenerKilledCalls = 0;
const listenerKilledSession = new Agent({
  llm: async () => {
    listenerKilledCalls += 1;
    return [assistantMessage("should not run")];
  },
}).createSession();
const listenerKilledEvents: AgentEvent[] = [];
listenerKilledSession.subscribe((event) => {
  listenerKilledEvents.push(event);

  if ("role" in event && event.role === "user") {
    listenerKilledSession.kill();
  }
});

await assert.rejects(
  listenerKilledSession.submit(userMessage("kill now")),
  /Session killed/
);

assert.equal(listenerKilledCalls, 0);
assert.deepEqual(listenerKilledSession.history(), []);
assert.deepEqual(
  listenerKilledEvents.map(eventKind),
  ["user"]
);
