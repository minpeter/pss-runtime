import assert from "node:assert/strict";
import type {
  AssistantModelMessage,
  ToolCallPart,
  ToolModelMessage,
  UserModelMessage,
} from "ai";
import { Agent } from "../agent";
import type { Llm } from "../llm";
import type { AgentEvent, ModelHistoryItem, UserText } from "./events";

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const continueToolCall = (toolCallId: string): ToolCallPart => ({
  type: "tool-call",
  toolCallId,
  toolName: "continue",
  input: {},
});

const userText = (text: string): UserText => ({ type: "user-text", text });
const userModelMessage = (content: string): UserModelMessage => ({
  role: "user",
  content,
});

const assistantMessage = (
  content: AssistantModelMessage["content"]
): AssistantModelMessage => ({
  role: "assistant",
  content,
});

const continueToolResult = (toolCall: ToolCallPart): ToolModelMessage => ({
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

const firstLlmCall = createDeferred();
const seenHistory: UserModelMessage[][] = [];
let calls = 0;
const llm: Llm = async ({ history }) => {
  calls += 1;
  seenHistory.push([...history] as UserModelMessage[]);

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

const firstSubmit = session.submit(userText("first"));
const secondSubmit = session.submit(userText("second"));

session.interrupt();
firstLlmCall.resolve();

await Promise.all([firstSubmit, secondSubmit]);

assert.equal(calls, 2);
assert.deepEqual(seenHistory, [
  [userModelMessage("first")],
  [userModelMessage("first"), userModelMessage("second")],
]);
assert.deepEqual(session.history(), [
  userText("first"),
  userText("second"),
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

const toolLoopHistories: unknown[][] = [];
let toolLoopCalls = 0;
const toolLoopSession = new Agent({
  llm: ({ history }) => {
    toolLoopCalls += 1;
    toolLoopHistories.push([...history]);

    if (toolLoopCalls === 1) {
      const toolCall = continueToolCall("call-tool-loop-continue");
      return Promise.resolve([
        assistantMessage([toolCall]),
        continueToolResult(toolCall),
      ]);
    }

    return Promise.resolve([assistantMessage("DONE")]);
  },
}).createSession();

await toolLoopSession.submit(userText("remember me"));

const toolLoopCall = continueToolCall("call-tool-loop-continue");

assert.deepEqual(toolLoopHistories, [
  [userModelMessage("remember me")],
  [
    userModelMessage("remember me"),
    assistantMessage([toolLoopCall]),
    continueToolResult(toolLoopCall),
  ],
]);
assert.deepEqual(toolLoopSession.history(), [
  userText("remember me"),
  { type: "tool-call", toolName: "continue" },
  { type: "assistant-text", text: "DONE" },
]);

const failingSession = new Agent({
  llm: () => Promise.reject(new Error("model unavailable")),
}).createSession();
const failingEvents: AgentEvent[] = [];
failingSession.subscribe((event) => failingEvents.push(event));

await assert.rejects(
  failingSession.submit(userText("fail")),
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
    return [assistantMessage("should not render")];
  },
}).createSession();
const killedEvents: AgentEvent[] = [];
killedSession.subscribe((event) => killedEvents.push(event));

const activeSubmit = killedSession.submit(userText("active"));
const queuedSubmit = killedSession.submit(userText("queued"));
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
assert.deepEqual(killedSession.history(), [userText("active")]);
await assert.rejects(
  killedSession.submit(userText("after kill")),
  /Session killed/
);
assert.deepEqual(killedSession.history(), [userText("active")]);
assert.deepEqual(
  killedEvents.map((event) => event.type),
  ["user-text", "turn-start", "step-start", "user-text", "turn-abort"]
);

let listenerKilledCalls = 0;
const listenerKilledSession = new Agent({
  llm: () => {
    listenerKilledCalls += 1;
    return Promise.resolve([assistantMessage("should not run")]);
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
  listenerKilledSession.submit(userText("kill now")),
  /Session killed/
);

assert.equal(listenerKilledCalls, 0);
assert.deepEqual(listenerKilledSession.history(), [] as ModelHistoryItem[]);
assert.deepEqual(
  listenerKilledEvents.map((event) => event.type),
  ["user-text"]
);
