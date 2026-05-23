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
