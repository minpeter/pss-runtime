<p align="center">
  <img src="../../assets/runtime-banner.png" alt="@minpeter/pss-runtime banner" width="100%" />
</p>

# @minpeter/pss-runtime

Minimal, platform-agnostic agent runtime with keyed threads, synchronized
`turn.events()`, and opaque persistence contracts.

## Core DX

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAgent } from "@minpeter/pss-runtime";
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

const agent = await createAgent({
  instructions: "Answer briefly.",
  model: provider(env.AI_MODEL),
});

const turn = await agent.send("Hello");
for await (const event of turn.events()) {
  console.log(event);
}
```

`turn.events()` is the turn driver. The runtime stops at synchronized lifecycle
boundaries until the events consumer asks for the next event, so callers must
consume the events for the turn to progress. This is what lets code react to
`turn-start`, `step-start`, and `step-end` before the next model snapshot is
created.

`thread.events({ after, limit })` replays durable, thread-scoped `AgentEvent`
records from the configured `AgentHost`. It is not a live turn driver; use it
to rebuild an event transcript after a turn has committed. Each replayed record
has a cursor, so callers can persist `record.cursor` and resume with
`thread.events({ after: cursor })`.

`model` is the single public constructor key for model execution. Pass an AI SDK
`LanguageModel` object and configure runtime-owned prompting through
`instructions`, `tools`, and `toolChoice`:

```ts
import { openai } from "@ai-sdk/openai";
import { createAgent } from "@minpeter/pss-runtime";

const model = openai("gpt-4.1-mini");

const agent = await createAgent({
  instructions: "Answer with concise operational notes.",
  model,
});
```

Per-key conversations use `thread(key)`:

```ts
const roomThread = agent.thread("room:123:user:456");
const turn = await roomThread.send(["Context: user prefers short answers", "Hi"]);
for await (const event of turn.events()) {
  // events for this single turn
}
```

`agent.send(...)` is shorthand for `agent.thread("default").send(...)`.

## Plugins

Plugins are async factories. The public plugin kernel stays fixed at `on()` for
typed lifecycle handlers and `provide()` for capabilities:

```ts
import {
  createAgent,
  definePlugin,
  threadScope,
} from "@minpeter/pss-runtime";

const protocolGuard = definePlugin(async (pss, { signal }) => {
  const state = pss.provide(threadScope(() => ({ findings: 0 })));

  pss.on("input.accept", (_event, context) => {
    state.get(context.thread).findings += 1;
    return { action: "continue" };
  });

  pss.on("model.context", () => ({ action: "continue" }));

  signal.throwIfAborted();
});

const agent = await createAgent({ model, plugins: [protocolGuard] });
```

Factories initialize sequentially in registration order and all finish before
`createAgent()` resolves. Factory and hook failures fail closed: they abort agent
creation or the current operation. `pluginFactoryTimeoutMs` and
`pluginHookTimeoutMs` configure the runtime-wide timeouts. `on()` and non-state
`provide()` calls return an idempotent `Subscription`. Registration closes when
the factory resolves; retaining `pss` and attempting a later `on()` or
`provide()` throws `PluginRegistrationClosedError`. Subscriptions remain usable
after initialization, including for tools and history policies already attached
to active threads.

Register an AI SDK tool from a plugin with the `registerTool()` capability
helper:

```ts
import { registerTool } from "@minpeter/pss-runtime";

pss.provide(registerTool({ name: "weather", tool: weatherTool }));
```

For model providers that support multimodal input, send JSON-serializable content
parts through the same API. String input and `readonly string[]` remain supported
shortcuts for text-only turns.

```ts
const turn = await agent.send([
  { type: "text", text: "Describe this UI screenshot." },
  {
    type: "file",
    data: "data:image/png;base64,iVBORw0KGgo...",
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

Inline bytes and base64 data URLs are runtime-owned attachments. Before the
input is committed, the runtime writes them to the configured `attachmentStore`
and persists only internal `pss-attachment:` refs in events, snapshots, queued
inputs, and notifications. Image byte inputs are normalized on every host before `put` so stored image
attachments are always `image/jpeg` or `image/png` (never HEIC/AVIF/WebP/etc.).
Policy: keep small valid JPEG/PNG as-is; otherwise decode and re-encode —
opaque → JPEG, transparent → PNG (with JPEG fallback if PNG cannot fit the
budget). Default max size is 240KB (`maxImageBytes`). Non-image files are left
unchanged. Refs are hydrated back into
bytes immediately before model generation. Custom hosts that accept byte inputs
must provide an `attachmentStore` with `put`, `get`, and `delete`; remote
`http(s)` media stays as a provider URL/reference and is not fetched by the
runtime.

The public transcript protocol is `AgentEvent`: live turns emit runtime-defined
events through `turn.events()`. Provider/model message history is internal
continuation state, not a public history API.

## Delegation

Delegation is app-owned. Build ordinary tools that call another `Agent`,
`thread.send(...)`, notification resume, or host-owned background work, then
return the compact result shape your product wants the model to see.

```ts
const reader = await createAgent({
  instructions: "Read knowledge-base files and cite paths.",
  model,
  namespace: "reader",
});

const coordinator = await createAgent({
  instructions: "Coordinate work and delegate knowledge-base reads.",
  model,
  namespace: "coordinator",
  tools: {
    delegate_to_reader: tool({
      description: "Ask the reader agent to inspect the knowledge base.",
      execute: async ({ prompt }) => {
        const turn = await reader.thread("kb").send(prompt);
        const text: string[] = [];
        for await (const event of turn.events()) {
          if (event.type === "assistant-output") {
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
notifications, `Agent.resume(...)`, and `turn.events()`; it does not generate
delegation tools or own child-agent lifecycle semantics. See
the sync and background example packages for app-owned blocking and background
delegation patterns.

## Plugin event semantics

Use `pss.on(...)` inside a plugin factory to observe or intercept typed runtime
events:

```ts
import { createAgent, definePlugin } from "@minpeter/pss-runtime";

const tracePlugin = definePlugin((pss) => {
  pss.on("turn.end", (event) => {
    console.log(event.type); // "turn-end"
  });
});

const agent = await createAgent({
  model,
  plugins: [tracePlugin],
});
```

### Model context and step interception

Use `model.context` as an ephemeral read guard immediately before each model
call. Its result changes only the provider-visible messages; it does not rewrite
stored thread history. The same hook runs for automatic-compaction model calls.

Use `model.step.before` to validate or transform a complete model step after
generation and before any message from that step is appended or any mapped
output event is emitted. Multiple transforms chain in plugin registration
order, and failures stop the turn without partially appending the step.

```ts
import { definePlugin } from "@minpeter/pss-runtime";

const protocolGuard = definePlugin((pss) => {
  pss.on("model.context", ({ messages }) => ({
    action: "transform",
    value: { messages: sanitizeModelContext(messages) },
  }));

  pss.on("model.step.before", ({ messages }) => ({
    action: "transform",
    value: { messages: sanitizeModelStep(messages) },
  }));

  pss.on("thread.compaction.before", ({ input }) =>
    isUnsafeCompaction(input) ? { action: "cancel" } : undefined
  );
});
```

Thread-state shape validation remains an internal runtime invariant at decode,
in-memory append, and encode boundaries. Plugins do not receive a loaded-state
or pre-commit mutation capability.

Persisted-history repair belongs in a separate recovery job. The job should
load a versioned snapshot, produce an auditable object diff before writing, and
commit only with the loaded version as `expectedVersion`:

```ts
interface StoredThreadRecoveryPlan {
  readonly threadKey: string;
  readonly expectedVersion: string;
  readonly before: {
    readonly history: readonly unknown[];
    readonly compactions: readonly unknown[];
  };
  readonly after: {
    readonly history: readonly unknown[];
    readonly compactions: readonly unknown[];
  };
  readonly quarantined: readonly {
    readonly reason: string;
    readonly seq: number;
  }[];
}
```

On a version conflict, the recovery job must reload and recompute the diff; it
must not overwrite a thread that changed after inspection.

### Observe vs intercept

Notification events are observe-only. Request events such as `input.accept`,
`model.context`, `model.step.before`, `provider.request.before`,
`thread.compaction.before`, `tool.call.before`, `tool.result`, and
`turn.start.before` may return a typed decision. Invalid runtime results fail
closed with `PluginHookError`.

Request hooks cover these boundaries:

- `input.accept` for `user-input` and `runtime-input`
- `turn.start.before` before `turn.start`
- `model.context` before each model call
- `model.step.before` after generation and before atomic step append
- `provider.request.before` immediately before the provider request
- `thread.compaction.before` before manual, background, or overflow compaction
- `tool.call.before` is plugin-only; it is synthesized after the `before-tool`
  checkpoint and before tool `execute`, and is not emitted on `turn.events()`
- `tool.result` after tool execution and before its result returns to the model

Return one of:

- `{ action: "continue" }` — continue with the current value (default when omitted)
- `{ action: "transform", value: event }` — replace the value for transformable
  input, context, model-step, provider, compaction, tool-result, and turn-start
  requests
- `{ action: "transform", input }` — replace tool arguments for
  `tool.call.before` only (not `value`; chained; drives tool `execute`)
- `{ action: "handled" }` — skip emit; for `thread.send`, close the run without
  starting a turn (`user-input` and `runtime-input` only)
- `{ action: "cancel" }` — cancel compaction without changing thread state
- `{ action: "block", reason? }` — skip tool execution and synthesize a blocked
  tool result so the model loop can continue
- `{ action: "needs-recovery" }` — stop before real tool execution and mark the
  durable run for manual recovery (`tool.call.before` only)

Plugins run in registration order. Each `transform` updates the event seen by
later plugins, so transforms chain sequentially.

### Tool-call interception

Handle `tool.call.before` after the runtime writes the
`before-tool` checkpoint and before the tool's `execute` function runs:

```ts
import { definePlugin } from "@minpeter/pss-runtime";

const approvalPlugin = definePlugin((pss) =>
  pss.on("tool.call.before", (event) => {
    if (event.toolName === "write_file") {
      return { action: "needs-recovery" };
    }
    return { action: "continue" };
  })
);

const pathJailPlugin = definePlugin((pss) =>
  pss.on("tool.call.before", (event) => {
    if (event.toolName !== "write_file" || !isWriteInput(event.input)) {
      return { action: "continue" };
    }
    return {
      action: "transform",
      input: { ...event.input, path: jailPath(event.input.path) },
    };
  })
);
```

`tool.call.before` events carry `toolName`, `toolCallId`, `input`, `policy`,
`attempt`, and `idempotencyKey`. Plugin handlers also receive current
model-message `history` and `signal` through `PluginEventContext`. The runtime
snapshots `tool.call.before` payloads before each plugin runs, so **in-place
mutations of the event object do not affect later plugins or tool execution**.
To change the input that reaches `execute`, return an explicit decision:

- `{ action: "transform", input }` — replace the tool input (chained in
  registration order; the final value is what `execute` receives)
- `{ action: "block", reason? }` — skip execution and synthesize a blocked result
- `{ action: "needs-recovery" }` — stop before real execution for durable recovery
- `{ action: "continue" }` — leave the current input unchanged (default when omitted)

Keep tool inputs structured-cloneable and reasonably sized: the runtime clones
the working input once per plugin, and transform inputs must also be
structured-cloneable. `handled` is not valid for `tool.call.before`; invalid
decisions fail closed with `PluginHookError`, including a transform missing
`input`, `input: undefined`, or a non-cloneable `input` (for example a function).
If an earlier plugin transforms and a later one returns `block` or
`needs-recovery`, execution and `tool.execution.start` are skipped.

`tool.execution.start` runs only after every `tool.call.before` handler continues
(and carries the final transformed input when transforms were applied).
`tool.result` transforms chain in registration order, followed by the
observe-only `tool.execution.end` event carrying the final result.

### Input `meta.source`

The runtime attaches `meta` on input events at API boundaries. Plugins can route
on `event.meta?.source`:

| `source` | Boundary |
|----------|----------|
| `send` | `thread.send()` / `agent.send()` |
| `steer` | `thread.steer()` and drained steering queue |
| `notify` | host notification runtime input |
| `delegate` | parent `delegate_to_*` child `thread.send()` |

`meta` appears on `turn.events()` for input events but is stripped before thread
history persistence and model mapping. It never reaches the LLM prompt.

### Delegate prompt wrapping

Child agents receive delegated prompts with `meta.source === "delegate"`. Wrap or
rewrite text input with a plugin instead of agent-level prompt shims:

```ts
import { createAgent, definePlugin, type UserText } from "@minpeter/pss-runtime";

const pokeTagsPlugin = definePlugin((pss) => {
  pss.on("input.accept", (event) => {
    if (
      event.type !== "user-input" ||
      event.meta?.source !== "delegate" ||
      !("text" in event)
    ) {
      return;
    }

    const text =
      typeof event.text === "string" ? event.text : event.text.join("\n");

    return {
      action: "transform",
      value: {
        ...event,
        text: `<poke>\n${text}\n</poke>`,
      } satisfies UserText,
    };
  });
});

const executionAgent = await createAgent({
  namespace: "execution",
  plugins: [pokeTagsPlugin],
  model,
});
```

The parent coordinator stays unchanged; only the nested child agent carries the
plugin.

## Send, Host Resume, and Steer

Use `thread.send(input)` for a new user turn. If a turn is already active, the
turn is queued until the active turn finishes. Use `thread.steer(input)` when
the input should steer the active turn; if no turn is active, it starts a normal
turn.

Durable hosts resume completed background work by writing a notification record
and calling `agent.resume(notificationRunId)`. The resume call claims the
notification idempotently through its durable run id and returns one `AgentTurn`,
or `null` when a duplicate queue/alarm delivery already claimed it.

`agent.resume(runId)` also returns `null` when the host does not support durable
resume (`agent.supportsResume === false`); it never throws for an unsupported
host. Check `supportsResume` first when you need to distinguish an unsupported
host from a missing or already-claimed run.

Runtime-originated input is delivered through the host notification inbox and
internal plugin paths. App code should use `thread.send()`, `thread.steer()`,
or `agent.resume(runId)` for host-scheduled durable work.

Each accepted call returns one `AgentTurn`. Drain that turn's `events()` stream to
observe the turn; each `AgentTurn.events()` stream is single-consumer.

Input APIs accept strings, arrays of strings, or multipart arrays such as
`[{ type: "text", text: "hello" }, { type: "file", data: imageBytes, mediaType: "image/png" }]`. Inline
image/file bytes are staged into `attachmentStore` and replaced by
`pss-attachment:` refs before durable state is written. The runtime normalizes
accepted `send` input into `user-input` events. Active steering and host resume
input emit `runtime-input` events. A `runtime-input` is runtime/API-originated
input mapped internally to the model's user role. It is distinct from
human-origin `user-input` events.

Runtime input windows are tied to synchronized events:

- `turn-start`: input is appended after the original turn input and before the first model snapshot.
- `step-start`: input is appended before that same step's model snapshot.
- `step-end`: input is appended before the next step and intentionally continues the current turn, even if the assistant text looked final.

Guard `step-end` insertion with a one-shot flag or a real condition. Adding input
on every `step-end` can keep the turn running indefinitely.

```ts
const thread = agent.thread("room:123:user:456");
const turn = await thread.send("Draft a short answer.");
let addedSteer = false;

for await (const event of turn.events()) {
  if (event.type === "assistant-output") {
    process.stdout.write(event.text);
  }

  if (event.type === "step-end" && !addedSteer) {
    addedSteer = true;
    await thread.steer("Also mention the main tradeoff.");
  }
}
```

`thread.steer()` resolves when the input is accepted into the active turn's
pending steering path or, when idle, when a new turn is scheduled. It does not wait
for a later model snapshot.

## Thread Storage and Portability

The runtime owns full thread state encoding and history compaction semantics.
Adapters own persistence only through `ThreadStore`:

Stored thread state is an opaque, versioned runtime snapshot for continuation.
Do not inspect it as a replay log. Use `thread.events({ after, limit })` with an
`AgentHost` when a product needs a durable `AgentEvent` transcript.

`ThreadStore` is snapshot-only. It does not own background task ids, run
leases, checkpoints, notification inbox state, or scheduling. Those live on the
optional `host` execution contract.

Custom stores own version generation. `load(key)` returns the opaque `state` with
the store-minted `version`; `commit(key, { state }, { expectedVersion })` receives
state only and should reject stale versions by returning `{ ok: false, reason:
"conflict" }`. On success, the store persists `{ state, version }` and returns the
new version to the runtime. `delete(key)` removes the persisted thread for that
key.

```ts
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";

const agent = await createAgent({
  host: createInMemoryHost(),
  model,
  namespace: "support-agent",
});
```

For durable local Node threads, use the file platform adapter. Set a stable `namespace` so
reconstructed agents map the same app-owned thread keys back to the same
transcripts:

```ts
import { createFileHost } from "@minpeter/pss-runtime/platform/file";

const agent = await createAgent({
  host: createFileHost({ directory: ".pss/threads" }),
  model,
  namespace: "support-agent",
});
```

Use `inspectFileThread` when local tooling needs to inspect the exact file
runtime uses for a thread:

```ts
import { inspectFileThread } from "@minpeter/pss-runtime/platform/file";

const report = await inspectFileThread({
  directory: ".pss/threads",
  key: "room:123:user:456",
});

console.log(report.messageCount, report.compactionCount, report.storageFile);
```

There is a single host contract: `AgentHost` (`HostStore` + `HostScheduler` + optional
`HostAttachmentStore`). When `host` is omitted, `createAgent()` defaults to
`createInMemoryHost()`. Platform factories (`createInMemoryHost`,
`createFileHost`, `createCloudflareHost`) all return that same shape.
`createCloudflareHost` is the Cloudflare Agents SDK path (fibers + schedule).
For store/alarm-only DO tooling use `createCloudflareStorageHost`.

Automatic compaction can also enforce a pre-provider context budget:

```ts
const agent = await createAgent({
  autoCompaction: {
    contextGate: {
      maxInputTokens: 120_000,
      onOverflow: "compact",
    },
    minMessages: 24,
    retainMessages: 8,
  },
  model,
});
```

`contextGate` estimates the prompt immediately before `generateText`. With
`onOverflow: "error"`, the turn fails before the provider is called. With
`onOverflow: "compact"` (the default), the runtime runs blocking compaction and
retries once. Provider-thrown context-window errors still use the same blocking
compaction fallback.

Hosts that need durable runs pass `host:` into `createAgent()`. The execution subpath
exports the same `AgentHost` contract used by platform factories:

```ts
import { createAgent } from "@minpeter/pss-runtime";
import type { AgentHost } from "@minpeter/pss-runtime/execution";
import { createInMemoryHost } from "@minpeter/pss-runtime/platform/memory";

const host: AgentHost = createInMemoryHost();

const agent = await createAgent({
  host,
  model,
  namespace: "support-agent",
});
```

## Supported Deployment Shapes

The runtime supports both long-running Node.js processes and edge hosts that
reconstruct runtime objects between turns. The same public DX stays centered on
`await createAgent({ model, tools, host })`; host-specific durability and scheduling live
behind the `host` boundary.

Long-running Node.js can keep an `Agent` and `ThreadHandle` alive across turns.
Use `@minpeter/pss-runtime/platform/file` when a local process should persist
thread snapshots on disk between restarts:

```ts
import { createAgent } from "@minpeter/pss-runtime";
import { createFileHost } from "@minpeter/pss-runtime/platform/file";

const agent = await createAgent({
  host: createFileHost({ directory: ".pss-local-threads" }),
  model,
});
```

App-owned background work still needs its own durable task/output storage if it
must survive process restarts.

Cloudflare Durable Objects and similar edge hosts should call `createAgent()` per
turn and persist opaque thread state through a durable `threadStore`.
Use `@minpeter/pss-runtime/platform/cloudflare` for the packaged Cloudflare Durable
Object adapter. See the sync example package for blocking app-owned delegation
and the background example package for durable background delegation in a local
interactive CLI.

Cloudflare is the preferred substrate when deploying PSS Runtime on Workers and
Durable Objects, but runtime core stays platform-agnostic. Do not import the
Cloudflare Agents SDK, `cloudflare:agents`, or other Cloudflare SDK packages from
core runtime code. Use `@minpeter/pss-runtime/platform/cloudflare` as the
canonical Cloudflare adapter for Durable Object storage, alarms, dispatch, and
Cloudflare Agents SDK fiber, schedule, recovery, and context helpers.

**Cloudflare agent products use the Agents SDK path only.** Implement the
Worker DO as a Cloudflare Agents SDK `Agent` subclass and wire PSS through
`createCloudflarePlatformContext` / `createCloudflareHost({ cloudflareAgent,
durableObjectContext: this.ctx, resume, ... })`. Immediate run/thread resumes map
to `startFiber()`, delayed resumes to SDK `schedule()`, and recovery to
`onFiberRecovered()`. HTTP app routes should use `onRequest` (PartyServer entry).
Scheduled callback and recovery payloads are prefix-guarded by default; pass
`allowedPrefixes` or `allowPrefix` for multi-namespace Workers. The
`worker-agent` app is the reference. Low-level `createCloudflareStorageHost`
remains available for store inspection and tests; wake/resume is Agents-owned
via `createCloudflarePlatformContext` / fibers.

**Migration from alarm drain:** the DO `alarm` / alarm-scheduler dual stack was
removed. Pending work that used the shared scheduled-work kinds (`run`,
thread prompts) is still listed/acked through Agents fibers and
`createCloudflareScheduledWorkScheduler` storage rows; do not re-arm DO `setAlarm`
for PSS turn drain.

### Platform adapter parity

Every platform adapter implements the same core ports — `HostStore`
(turns, checkpoints, run events, thread events, notifications, threads) and `HostScheduler`
(run enqueueing and thread resumes) — and each is verified by shared in-repo
contract test suites (internal, not part of the published API).
Platform-neutral scheduled-work semantics (work-id derivation, thread-prompt
validation, list limits) live in runtime core; adapters only bind storage and
timers.

| Capability                            | memory            | file                     | cloudflare                    |
| ------------------------------------- | ----------------- | ------------------------ | ----------------------------- |
| Thread + execution stores             | yes               | yes                      | yes                           |
| Scheduled runs and thread prompts     | list/ack, deduped | list/ack, deduped        | list/ack/claim, deduped       |
| Delayed runs (`runAfterMs`)           | due-time filtered | due-time filtered        | Agents `schedule()` / fibers  |
| Product host factory                  | `createInMemoryHost` | `createFileHost`      | `createCloudflareHost`        |
| Low-level storage host                | —                 | —                        | `createCloudflareStorageHost` |
| Drain helper                          | app-driven        | `drainScheduledNodeWork` | Agents fiber resume               |
| Scheduled fiber retry backoff         | —                 | —                        | Cloudflare Agents SDK adapter |

The same core API supports room/user/thread routing through stable thread keys.

Recommended key patterns:

- Shared room conversation: `room:<roomId>`
- Per-user memory inside room: `room:<roomId>:user:<userId>`
- Ticketed workspace flows: `tenant:<tenantId>:ticket:<ticketId>`

In a Durable Object, map the execution store contract to `ctx.storage` so DO
storage is durable across hibernation/restores, while in-memory state remains
request-local. Do not store canonical agent session or run state in memory
attachments.

Durable background workflows require host-owned task ids, attempts, leases,
checkpoints, cancellation, scheduling, thread snapshots, and completion
notifications. The Cloudflare adapter persists scheduled runs and thread
prompts, sets alarms, and resumes work through `Agent.resume(...)`.

Use `dispatchCloudflareAgentsNotification` (or host-level notification
dispatch) for later events such as reminders and connector callbacks. Delayed
work is woken by the Agents SDK schedule/fiber path through
`createCloudflarePlatformContext`.


## Checkpoints and Cancellation

Resume is safe only at committed boundaries. Durable hosts can checkpoint before
and after model steps, around notifications, before child run creation, when a
child link is committed, and when a run suspends. If a process is killed inside a
provider call or unsafe tool execution, resume rolls back to the last committed
checkpoint and may re-enter the operation.

When `createAgent()` receives an `AgentHost`, high-level model turns create a
`user-turn` run record and thread tool execution context into managed model
calls. Tools are checkpointed before and after execution and receive stable
`attempt`, `idempotencyKey`, `retryPolicy`, `signal`, and public `toolCallId`
values. The `@minpeter/pss-runtime/execution`
entrypoint also exposes the same low-level tool execution checkpoint types for
custom resume runners built directly on AI SDK `LanguageModel` objects.

These checkpoints are rollback boundaries, not a complete host adapter by
themselves. Edge hosts still need durable scheduling, leases, resume workers,
and notification resume handling; externally visible side-effect tools still need
idempotent execution or a manual recovery flow.

Cancellation is persisted before aborting active work. `delete()` and `dispose()`
stop the current session's in-process work; durable hosts remain responsible for
any app-owned background run cancellation, cleanup, and notification policy.
