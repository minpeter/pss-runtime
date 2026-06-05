<p align="center">
  <img src="../../assets/runtime-banner.png" alt="@minpeter/pss-runtime banner" width="100%" />
</p>

# @minpeter/pss-runtime

Minimal, platform-agnostic agent runtime with keyed sessions, synchronized
`run.events()`, and opaque persistence contracts.

## Core DX

```ts
import { Agent } from "@minpeter/pss-runtime";
import { createYourLanguageModel } from "...";

const agent = await Agent.create({
  instructions: "Answer briefly.",
  model: createYourLanguageModel(),
});

const run = await agent.send("Hello");
for await (const event of run.events()) {
  console.log(event);
}
```

`run.events()` is the run driver. The runtime stops at synchronized lifecycle
boundaries until the events consumer asks for the next event, so callers must
consume the events for the run to progress. This is what lets code react to
`turn-start`, `step-start`, and `step-end` before the next model snapshot is
created. `AgentRun.events()` is single-consumer by design: keep rendering,
logging, tracing, and continuation policy in the same app-owned loop when those
concerns must share synchronized boundary control.

```ts
const run = await agent.send("Implement the plan.");
const session = agent.session("default");

for await (const event of run.events()) {
  renderEvent(event);
  traceEvent(event);

  if (event.type === "step-end" && shouldContinueWork()) {
    await session.steer("Continue. The task is not complete yet.");
  }
}
```

Per-key conversations use `session(key)`:

```ts
const roomSession = agent.session("room:123:user:456");
const run = await roomSession.send(["Context: user prefers short answers", "Hi"]);
for await (const event of run.events()) {
  // events for this single turn
}
```

`agent.send(...)` is shorthand for `agent.session("default").send(...)`.

For model providers that support multimodal input, send JSON-serializable content
parts through the same API. String input and `readonly string[]` remain supported
shortcuts for text-only turns.

```ts
const run = await agent.send([
  { type: "text", text: "Describe this UI screenshot." },
  {
    type: "image",
    image: "data:image/png;base64,iVBORw0KGgo...",
    mediaType: "image/png",
  },
]);
```

File parts use the same JSON-serializable shape when the selected model supports
file input:

```ts
await agent.send([
  { type: "text", text: "Summarize the attached report." },
  {
    type: "file",
    data: "data:application/pdf;base64,JVBERi0x...",
    filename: "report.pdf",
    mediaType: "application/pdf",
  },
]);
```

The runtime normalizes and persists these content parts as session continuation
state; it does not fetch remote media, decode files, or guarantee provider support
for every media type.

The public transcript protocol is `AgentEvent`: live runs emit runtime-defined
events through `run.events()`. Provider/model message history is internal
continuation state, not a public history API.

## Send and Steer

Use `session.send(input)` for a new user turn. If a run is already active, the
turn is queued until the active run finishes. Use `session.steer(input)` when the
input should steer the active run; if no run is active, it starts a normal run.

Both APIs accept the same input shapes: strings, arrays of strings,
`{ type: "user-text", text }`, and multipart `{ type: "user-message", content }`
values. Active steering emits `runtime-input` events. A `runtime-input` is
runtime/API-originated input mapped internally to the model's user role. It is
distinct from human-origin `user-text` and `user-message` events.

Runtime input windows are tied to synchronized events:

- `turn-start`: input is appended after the original turn input and before the first model snapshot.
- `step-start`: input is appended before that same step's model snapshot.
- `step-end`: input is appended before the next step and intentionally continues the current turn, even if the assistant text looked final.

Guard `step-end` insertion with a one-shot flag or a real condition. Adding input
on every `step-end` can keep the turn running indefinitely.

```ts
const session = agent.session("room:123:user:456");
const run = await session.send("Draft a short answer.");
let addedSteer = false;

for await (const event of run.events()) {
  if (event.type === "assistant-text") {
    process.stdout.write(event.text);
  }

  if (event.type === "step-end" && !addedSteer) {
    addedSteer = true;
    await session.steer("Also mention the main tradeoff.");
  }
}
```

`session.steer()` resolves when the input is accepted into the active run's
pending steering path or, when idle, when a new run is scheduled. It does not wait
for a later model snapshot.

## Plugins, Session Storage, Memory, And Compaction

The runtime owns full session state encoding and history compaction semantics.
Persistence, memory, and compaction are configured through in-process plugins:

```ts
import { Agent } from "@minpeter/pss-runtime";
import { compaction, memory, sessions } from "@minpeter/pss-runtime/plugins";

const agent = await Agent.create({
  model,
  plugins: [sessions.file(".pss/sessions"), memory(), compaction()],
});
```

If no persistence plugin is provided, sessions are memory-backed by default.

Reusable middleware belongs in plugins. Plugins can observe turn and step
lifecycle events and call the scoped `steer` function to insert runtime input at
the active boundary. App-level control should stay with `run.events()` plus
`session.steer()`; plugin lifecycle is for reusable policy.

Plugin event names are dotted middleware names: `turn.before`, `step.before`,
`step.after`, `turn.after`, `tool.call`, and `tool.result`. These are separate
from public `run.events()` transcript names such as `turn-start`, `step-start`,
`assistant-text`, `tool-call`, `tool-result`, `step-end`, and `turn-end`.

```ts
import { Agent, definePlugin } from "@minpeter/pss-runtime";

const continuePlugin = definePlugin({
  name: "continue-policy",
  setup(host) {
    host.on("step.after", async ({ result, history, steer, stepIndex }) => {
      if (result === "completed" && stepIndex === 0 && shouldContinueWork(history)) {
        await steer("Continue. The task is not complete yet.");
      }
    });
  },
});

const agent = await Agent.create({
  model,
  plugins: [continuePlugin],
});
```

`turn.after` is useful for audit, metrics, or scheduling a separate follow-up
run after the current turn has committed.

```ts
const auditPlugin = definePlugin({
  name: "turn-audit",
  setup(host) {
    host.on("turn.after", ({ result, sessionKey }) => {
      recordTurnResult(sessionKey, result);
    });
  },
});
```

Tool policy hooks apply to runtime-owned tools in the `Agent.create({ model,
tools })` path, including tools registered by plugins. Custom `llm` callers own
their tool execution and do not receive synthetic tool hook events.

`tool.call` runs after AI SDK input parsing and before the original tool
`execute`. Handlers run in plugin registration order. `allow` continues to the
next handler, `modify` replaces the input for later handlers and execution,
`reject-and-continue` skips the original tool and returns a rejection payload to
the model, `synthesize` skips the original tool and returns a synthetic output,
and `error` fails the active run.

```ts
import { definePlugin } from "@minpeter/pss-runtime";

const toolPolicyPlugin = definePlugin({
  name: "tool-policy",
  setup(host) {
    host.on("tool.call", ({ input, tool }) => {
      if (tool === "delete_file") {
        return {
          action: "reject-and-continue",
          message: "delete_file is disabled in this workspace.",
        };
      }

      if (tool === "search" && shouldNarrowSearch(input)) {
        return { action: "modify", input: narrowSearchInput(input) };
      }

      return { action: "allow" };
    });
  },
});
```

`tool.result` runs after allowed/modified execution, rejected calls, synthesized
calls, and original tool errors. It can observe or replace the model-facing
result with `{ status: "done", output }`, `{ status: "error", error, output }`,
or `{ status: "cancelled", error, output }`. Replacements flow into later
`tool.result` handlers.

```ts
const resultPolicyPlugin = definePlugin({
  name: "tool-result-policy",
  setup(host) {
    host.on("tool.result", ({ output, status, tool }) => {
      if (tool === "read_secret" && status === "done") {
        return {
          status: "done",
          output: redactSecretOutput(output),
        };
      }
    });
  },
});
```

Custom stores still own version generation through `SessionStore`. Use
`sessions.custom(store)` when the runtime should persist through a caller-owned
store:

```ts
import type { SessionStore } from "@minpeter/pss-runtime";
import { sessions } from "@minpeter/pss-runtime/plugins";

declare const store: SessionStore;

const agent = await Agent.create({
  model,
  plugins: [sessions.custom(store)],
});
```

Stored session state is opaque, versioned runtime continuation state:

Do not inspect it as a replay log; exact replay should be modeled separately as
an `AgentEvent` log if that capability is added later.

`load(key)` returns the opaque `state` with the store-minted `version`;
`commit(key, { state }, { expectedVersion })` receives state only and should
reject stale versions by returning `{ ok: false, reason: "conflict" }`. On
success, the store persists `{ state, version }` and returns the new version to
the runtime.

`memory()` adds session-scoped tools named `set_context`, `load_context`, and
`search_context`. Search is deterministic lexical matching by default; no
embedding provider is required. Memory is injected into model-facing context
without mutating top-level instructions.

`compaction()` stores non-destructive overlays with `startIndex` and `endIndex`.
The full canonical history remains in the session snapshot; summaries are
applied only to model-facing context.

## Future adapter boundary: Cloudflare multi-user DX

Cloudflare Durable Objects are a future adapter target, not a runtime dependency.
The same core API supports room/user/session routing through stable session keys.

Recommended key patterns:

- Shared room conversation: `room:<roomId>`
- Per-user memory inside room: `room:<roomId>:user:<userId>`
- Ticketed workspace flows: `tenant:<tenantId>:ticket:<ticketId>`

In a Durable Object, map the `SessionStore` contract to `ctx.storage` so DO storage is
durable across hibernation/restores, while in-memory state remains request-local.
Do not store canonical agent session state in memory attachments.
