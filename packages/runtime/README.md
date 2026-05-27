<p align="center">
  <img src="../../assets/runtime-banner.png" alt="@minpeter/pss-runtime banner" width="100%" />
</p>

# @minpeter/pss-runtime

Minimal, platform-agnostic agent runtime with sessions keyed through `run.stream()` and
opaque persistence contracts.

## Core DX

```ts
import { Agent } from "@minpeter/pss-runtime";
import { createYourLanguageModel } from "...";

const agent = await Agent.create({
  instructions: "Answer briefly.",
  model: createYourLanguageModel(),
});

const run = await agent.send("Hello");
for await (const event of run.stream()) {
  console.log(event);
}
```

`run.stream()` is the run driver. The runtime stops at synchronized lifecycle
boundaries until the stream consumer asks for the next event, so callers must
consume the stream for the run to progress. This is what lets code react to
`turn-start`, `step-start`, and `step-end` before the next model snapshot is
created.

Per-key conversations use `session(key)`:

```ts
const roomSession = agent.session("room:123:user:456");
const run = await roomSession.send(["Context: user prefers short answers", "Hi"]);
for await (const event of run.stream()) {
  // stream events for this single turn
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
events through `run.stream()`. Provider/model message history is internal
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

Runtime input windows are tied to synchronized stream events:

- `turn-start`: input is appended after the original turn input and before the first model snapshot.
- `step-start`: input is appended before that same step's model snapshot.
- `step-end`: input is appended before the next step and intentionally continues the current turn, even if the assistant text looked final.

Guard `step-end` insertion with a one-shot flag or a real condition. Adding input
on every `step-end` can keep the turn running indefinitely.

```ts
const session = agent.session("room:123:user:456");
const run = await session.send("Draft a short answer.");
let addedSteer = false;

for await (const event of run.stream()) {
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

## Session storage and portability

The runtime owns full session state encoding and history compaction semantics.
Adapters own persistence only through `SessionStore`:

Stored session state is an opaque, versioned runtime snapshot for continuation.
Do not inspect it as a replay log; exact replay should be modeled separately as
an `AgentEvent` log if that capability is added later.

```ts
import type { SessionStore } from "@minpeter/pss-runtime";
import { MemorySessionStore } from "@minpeter/pss-runtime/session-store/memory";

const agent = await Agent.create({
  model,
  sessions: {
    store: new MemorySessionStore(), // default when omitted
  },
});
```

For durable sessions, use the exported file POC:

```ts
import { FileSessionStore } from "@minpeter/pss-runtime/session-store/file";

const agent = await Agent.create({
  model,
  sessions: {
    store: new FileSessionStore(".pss/sessions"),
  },
});
```

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
