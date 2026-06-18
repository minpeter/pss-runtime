<p align="center">
  <img src="../../assets/runtime-banner.png" alt="@minpeter/pss-runtime banner" width="100%" />
</p>

# @minpeter/pss-runtime

Minimal, platform-agnostic agent runtime with keyed sessions, synchronized
`run.events()`, and opaque persistence contracts.

## Core DX

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@minpeter/pss-runtime";
import { createEnv } from "@t3-oss/env-core";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ path: ".env", quiet: true, override: true });
const env = createEnv({
  runtimeEnv: process.env,
  server: {
    AI_API_KEY: z.string().trim().min(1),
    AI_BASE_URL: z.url().trim().default("https://apis.opengateway.ai/v1"),
    AI_MODEL: z.string().trim().min(1).default("minimax/MiniMax-M2.7"),
  },
});

const provider = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
});

const agent = new Agent({
  instructions: "Answer briefly.",
  model: provider(env.AI_MODEL),
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
created.

`model` is the single public constructor key for model execution. Pass an AI SDK
`LanguageModel` object and configure runtime-owned prompting through
`instructions`, `tools`, and `toolChoice`:

```ts
import { openai } from "@ai-sdk/openai";
import { Agent } from "@minpeter/pss-runtime";

const model = openai("gpt-4.1-mini");

const agent = new Agent({
  instructions: "Answer with concise operational notes.",
  model,
});
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

## Delegation

Delegation is app-owned. Build ordinary tools that call another `Agent`,
`session.send(...)`, `session.notify(...)`, or host-owned background work, then
return the compact result shape your product wants the model to see.

```ts
const reader = new Agent({
  instructions: "Read knowledge-base files and cite paths.",
  model,
  namespace: "reader",
});

const coordinator = new Agent({
  instructions: "Coordinate work and delegate knowledge-base reads.",
  model,
  namespace: "coordinator",
  tools: {
    delegate_to_reader: tool({
      description: "Ask the reader agent to inspect the knowledge base.",
      execute: async ({ prompt }) => {
        const run = await reader.session("kb").send(prompt);
        const text: string[] = [];
        for await (const event of run.events()) {
          if (event.type === "assistant-text") {
            text.push(event.text);
          }
        }
        return { result: text.join("\n") };
      },
      inputSchema,
    }),
  },
});
```

For background delegation, let your host own task ids, scheduling, output
storage, and notification resume. The runtime provides generic execution stores,
notifications, `Agent.resume(...)`, and `run.events()`; it does not generate
delegation tools or own child-agent lifecycle semantics. See
the sync and background example packages for app-owned blocking and background
delegation patterns.

## Plugins

Pass `plugins: [...]` on `Agent` to observe or intercept runtime events. Each
plugin exposes one handler:

```ts
import type { AgentPlugin } from "@minpeter/pss-runtime";
import { Agent } from "@minpeter/pss-runtime";

const tracePlugin: AgentPlugin = {
  name: "trace",
  on: ({ event }) => {
    if (event.type === "turn-end") {
      console.log("turn finished");
    }
  },
};

const agent = new Agent({
  model,
  plugins: [tracePlugin],
});
```

### Observe vs intercept

For most events, `on` is observe-only: return nothing (or `{ action: "continue" }`)
and the runtime emits the event unchanged.

Three input event types support intercept returns:

- `user-text`
- `user-message`
- `runtime-input`

Return one of:

- `{ action: "continue" }` — emit the current event (default when omitted)
- `{ action: "transform", event }` — emit a replacement input event
- `{ action: "handled" }` — skip emit; for `session.send`, close the run without
  starting a turn

Plugins run in registration order. Each `transform` updates the event seen by
later plugins, so transforms chain sequentially.

### Input `meta.source`

The runtime attaches `meta` on input events at API boundaries. Plugins can route
on `event.meta?.source`:

| `source` | Boundary |
|----------|----------|
| `send` | `session.send()` / `agent.send()` |
| `steer` | `session.steer()` and drained steering queue |
| `notify` | `session.notify()` runtime input |
| `delegate` | parent `delegate_to_*` child `session.send()` |

`meta` appears on `run.events()` for input events but is stripped before session
history persistence and model mapping. It never reaches the LLM prompt.

### Delegate prompt wrapping

Child agents receive delegated prompts with `meta.source === "delegate"`. Wrap or
rewrite them with a plugin instead of agent-level prompt shims:

```ts
import type { AgentPlugin, UserText } from "@minpeter/pss-runtime";
import { Agent } from "@minpeter/pss-runtime";

const pokeTagsPlugin: AgentPlugin = {
  name: "poke-tags",
  on: ({ event }) => {
    if (event.type !== "user-text" || event.meta?.source !== "delegate") {
      return;
    }

    const text =
      typeof event.text === "string" ? event.text : event.text.join("\n");

    return {
      action: "transform",
      event: {
        ...event,
        text: `<poke>\n${text}\n</poke>`,
      } satisfies UserText,
    };
  },
};

const executionAgent = new Agent({
  namespace: "execution",
  plugins: [pokeTagsPlugin],
  model,
});
```

The parent coordinator stays unchanged; only the nested child agent carries the
plugin.

## Send, Host Resume, and Steer

Use `session.send(input)` for a new user turn. If a run is already active, the
turn is queued until the active run finishes. Use `session.steer(input)` when
the input should steer the active run; if no run is active, it starts a normal
run.

Durable hosts resume completed background work by writing a notification record
and calling `agent.resume(notificationRunId)`. The resume call claims the
notification idempotently through its durable run id and returns one `AgentRun`,
or `null` when a duplicate queue/alarm delivery already claimed it.

`agent.resume(runId)` also returns `null` when the host does not support durable
resume (`agent.supportsResume === false`); it never throws for an unsupported
host. Check `supportsResume` first when you need to distinguish an unsupported
host from a missing or already-claimed run.

Runtime-originated input is delivered through the host notification inbox and
internal plugin paths. App code should use `session.send()`, `session.steer()`,
or `agent.resume(runId)` for host-scheduled durable work.

Each accepted call returns one `AgentRun`. Drain that run's `events()` stream to
observe the turn; each `AgentRun.events()` stream is single-consumer.

Input APIs accept the same input shapes: strings, arrays of strings,
`{ type: "user-text", text }`, and multipart `{ type: "user-message", content }`
values. Active steering and host resume input emit `runtime-input` events. A
`runtime-input` is runtime/API-originated input mapped internally to the model's
user role. It is distinct from human-origin `user-text` and `user-message`
events.

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

## Session storage and portability

The runtime owns full session state encoding and history compaction semantics.
Adapters own persistence only through `SessionStore`:

Stored session state is an opaque, versioned runtime snapshot for continuation.
Do not inspect it as a replay log; exact replay should be modeled separately as
an `AgentEvent` log if that capability is added later.

`SessionStore` is snapshot-only. It does not own background task ids, run
leases, checkpoints, notification inbox state, or scheduling. Those live on the
optional `host` execution contract.

Custom stores own version generation. `load(key)` returns the opaque `state` with
the store-minted `version`; `commit(key, { state }, { expectedVersion })` receives
state only and should reject stale versions by returning `{ ok: false, reason:
"conflict" }`. On success, the store persists `{ state, version }` and returns the
new version to the runtime. `delete(key)` removes the persisted session for that
key.

```ts
import { MemorySessionStore } from "@minpeter/pss-runtime/session-store/memory";

const agent = new Agent({
  host: {
    sessionStore: new MemorySessionStore(), // default when omitted
  },
  model,
  namespace: "support-agent",
});
```

For durable sessions, use the exported file POC. Set a stable `namespace` so
reconstructed agents map the same app-owned session keys back to the same
transcripts:

```ts
import { FileSessionStore } from "@minpeter/pss-runtime/session-store/file";

const agent = new Agent({
  host: {
    sessionStore: new FileSessionStore(".pss/sessions"),
  },
  model,
  namespace: "support-agent",
});
```

A `host: { sessionStore }` object is a `SessionHost`-only host. That keeps session
persistence on your store but disables the in-memory `ExecutionHost`, so the
agent runs without durable run records, tool-execution checkpoints, or
`Agent.resume(...)`. `agent.supportsResume` is `false`. When omitted, `Agent`
defaults to an in-memory `ExecutionHost` (and its `MemorySessionStore`). Pass a
full `ExecutionHost` (or `DurableBackgroundHost`) when you need durable runs,
tool checkpoints, and resume alongside your `sessionStore`.

Hosts that need durable runs pass `host:` into `Agent`. The execution subpath
keeps the durable surface split by responsibility, so hosts can implement only
the capabilities they need: `SessionHost`, `RunHost`, `CheckpointHost`,
`EventHost`, `NotificationHost`, `BackgroundSchedulerHost`, and
`ExecutionTransactionHost`. `ExecutionHost` remains the aggregate contract for
in-process or full-store hosts, while `DurableBackgroundHost` and
`DurableNotificationResumeHost` describe the smaller durable surfaces required
for background scheduling and notification resume.

```ts
import { Agent } from "@minpeter/pss-runtime";
import {
  createInMemoryExecutionHost,
  type DurableBackgroundHost,
  type ExecutionHost,
} from "@minpeter/pss-runtime/execution";

const host = createInMemoryExecutionHost();

const agent = new Agent({
  host,
  model,
  namespace: "support-agent",
});

const durableHost: DurableBackgroundHost = {
  capabilities: {},
  backgroundScheduler,
  checkpointStore,
  eventStore,
  notificationInbox,
  runStore,
  sessionStore,
  transaction,
};
```

## Supported Deployment Shapes

The runtime supports both long-running Node.js processes and edge hosts that
reconstruct runtime objects between turns. The same public DX stays centered on
`new Agent({ model, tools, host })`; host-specific durability and scheduling live
behind the `host` boundary.

Long-running Node.js can keep an `Agent` and `SessionHandle` alive across turns.
`FileSessionStore` persists session snapshots only; app-owned background work
needs its own durable task/output storage if it must survive process restarts.

Cloudflare Durable Objects and similar edge hosts should reconstruct `Agent`
objects per turn and persist opaque session state through a durable
`sessionStore`.
Use `@minpeter/pss-runtime/cloudflare` for the packaged Cloudflare Durable
Object adapter. See the sync example package for blocking app-owned delegation
and the background example package for durable background delegation in a local
interactive CLI.

The same core API supports room/user/session routing through stable session keys.

Recommended key patterns:

- Shared room conversation: `room:<roomId>`
- Per-user memory inside room: `room:<roomId>:user:<userId>`
- Ticketed workspace flows: `tenant:<tenantId>:ticket:<ticketId>`

In a Durable Object, map the execution store contract to `ctx.storage` so DO
storage is durable across hibernation/restores, while in-memory state remains
request-local. Do not store canonical agent session or run state in memory
attachments.

Durable background workflows require host-owned task ids, attempts, leases,
checkpoints, cancellation, scheduling, session snapshots, and completion
notifications. The Cloudflare adapter persists scheduled runs and session
prompts, sets alarms, and resumes work through `Agent.resume(...)`.

## Checkpoints and Cancellation

Resume is safe only at committed boundaries. Durable hosts can checkpoint before
and after model steps, around notifications, before child run creation, when a
child link is committed, and when a run suspends. If a process is killed inside a
provider call or unsafe tool execution, resume rolls back to the last committed
checkpoint and may re-enter the operation.

When `Agent` receives an `ExecutionHost`, high-level model turns create a
`user-turn` run record and thread tool execution context into managed model
calls. Tools are checkpointed before and after execution and receive stable
`attempt`, `idempotencyKey`, `retryPolicy`, `signal`, and public `toolCallId`
values. The `@minpeter/pss-runtime/execution` entrypoint also exposes the same
low-level tool execution checkpoint types for custom resume runners built
directly on AI SDK `LanguageModel` objects.

These checkpoints are rollback boundaries, not a complete host adapter by
themselves. Edge hosts still need durable scheduling, leases, resume workers,
and notification resume handling; externally visible side-effect tools still need
idempotent execution or a manual recovery flow.

Cancellation is persisted before aborting active work. `delete()` and `dispose()`
stop the current session's in-process work; durable hosts remain responsible for
any app-owned background run cancellation, cleanup, and notification policy.
