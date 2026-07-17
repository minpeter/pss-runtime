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

### Cache-aware dynamic tools

PSS owns the logical outer model loop, so use `prepareModelStep` instead of AI
SDK `prepareStep` when a selection must follow PSS steps across separate
`generateText()` calls:

```ts
const agent = await createAgent({
  alwaysActiveTools: ["status"],
  model,
  prepareModelStep: async ({
    history,
    runtimeStepIndex,
    signal,
    threadKey,
    tools,
  }) => ({
    activeTools:
      runtimeStepIndex === 0
        ? await selectTools({ history, signal, threadKey, tools })
        : [],
  }),
  toolOrder: ["status", "search", "fetch"],
  tools: { fetch, search, status },
});
```

`runtimeStepIndex` is zero-based and counts completed logical PSS steps. A
context-overflow retry and a durable retry before state commit reuse the same
index; a suspended durable run continues at the next index. Automatic
compaction summaries are separate maintenance calls and do not invoke
`prepareModelStep`. `history` is the full transformed model context after
`model.context` hooks and before prompt normalization or attachment hydration,
including system/compaction messages.

`alwaysActiveTools` is a membership list. Its selected entries form the fixed
prefix; `prepareModelStep.activeTools` selects the dynamic suffix. Returning
`undefined` for `activeTools` selects every non-always-active registry tool,
while `[]` selects none of them. `toolOrder` controls ordering within the
always-active and dynamic groups: listed names come first and omitted registry
names follow alphabetically, while the always-active group remains the prefix.
Without configuration, all tool names are ordered alphabetically. The runtime
passes the effective order through AI SDK 7 `toolOrder`, removes every inactive
tool from AI SDK's executable registry, and rejects duplicate, unknown,
overlapping, malformed, or inactive named-tool selections before provider
work. Callback results may contain only `activeTools`, `model`, and
`toolChoice`; unknown or accessor-backed fields fail closed instead of silently
activating the full registry. `toolChoice: "required"` is rejected when no tool
is active. A `model` override must be a concrete AI SDK v2, v3, or v4 language
model object; string gateway IDs are rejected so step preparation cannot switch
to a different model-resolution path and bypass the provider wrapper or
middleware configured by the host. `activeTools` must be a dense array of
data-property strings; sparse or accessor-backed indices fail without invoking
their getters. Configured `alwaysActiveTools` and `toolOrder` use the same
registry-bounded snapshot, so array-subclass iterators, custom
`Symbol.iterator` accessors, sparse indices, and index getters are never used to
drive selection.

The callback receives a structured clone of history and a frozen registry of
isolated tool facades. History that cannot be structured-cloned fails closed
with `DataCloneError`. A tool facade recursively copies only own enumerable
data properties into frozen arrays or null-prototype records. Accessors are
skipped without invocation, custom prototypes are discarded, cycles preserve
their identity within the snapshot, and callable values become frozen inert
stubs that throw if invoked. This prevents reflection, methods, or a
non-configurable property from escaping back to the runtime's original tool
objects. Select by names and inert data metadata only; execute tools through
the normal model tool-call path.

Stable ordering reduces accidental tool-definition reordering, but dynamic
selection is not inherently cache-safe: changing the active set still changes
the provider request. Hosts with a diagnostics sink receive best-effort,
non-blocking `model.tool_cache_fingerprint` records. These contain only counts,
the logical step index, selector duration, an opaque attempt ID, and SHA-256
fingerprints. A new attempt ID is generated per actual `generateModelStep`
invocation, including retries and resumed attempts; `runtimeStepIndex` remains
the logical outer-loop index. This lets a host join selection diagnostics with
other records from the exact same model attempt. The record also counts dynamic
description functions and per-tool semantic fingerprints that were unavailable;
a single malformed schema therefore does not erase the rest of the diagnostic.

Name fingerprints cover the registered set, active set, and effective order.
For each active function or dynamic tool, PSS delegates the definition digest
to AI SDK 7.0.30's public `fingerprintTools`, which covers its tagged
description, resolved input JSON schema, and title. PSS then builds an ordered
aggregate that additionally binds the tool name, input examples, provider
options, and `strict`; provider tools bind their name, ID, arguments, and
provider options. AI SDK's separate `detectToolDrift` remains available to
hosts that persist and compare per-tool trust baselines; this runtime diagnostic
is an attempt-scoped correlation signal rather than a replacement drift policy.
Literal registry names such as `constructor`, `toString`, and `__proto__` stay
own properties throughout selection, execution filtering, and fingerprint-map
lookup.

The aggregate is a semantic drift signal, not a hash of the provider's final
wire bytes: dynamic description function results and adapter-specific lowering
are intentionally not evaluated. Records do not contain prompts, tool inputs,
definitions, thread keys, or unhashed semantic values. AI SDK currently lowers
provider tools from their name, provider ID, and arguments; hashing provider
options here intentionally captures extra host-side semantics and is not a
wire-equivalence claim. These hashes are correlation and version identifiers,
not secrecy controls: low-entropy tool names or standard schemas may be
recoverable by dictionary guessing.

The callback facade and the diagnostic snapshot are deliberately separate.
Diagnostics capture only own data descriptors for the semantic fields above,
then let AI SDK resolve supported JSON, Zod, standard, or lazy input schemas.
Accessor-backed fields and top-level tool definitions with custom prototypes
are recorded as unavailable rather than executed. Dynamic description
functions are counted and fingerprinted only by their presence; their result is
never evaluated. Schema conversion failures are isolated to that tool and
recorded through `semanticFingerprintUnavailableToolCount`; they never make the
model step fail. Metadata is canonicalized before the asynchronous digest so a
later host mutation cannot rewrite an in-flight diagnostic.

Model identity follows the same no-accessor rule. Data-backed
specification-version, provider, and model-ID fields are hashed directly. Some
official adapters expose `provider` through a prototype getter; PSS recognizes
that object as a usable AI SDK model without invoking the getter during
selection, hashes the safe data-backed identity fields plus an unavailable
marker, and sets `modelIdentityFingerprintUnavailable` to `true`.

This local registry selector does not emulate provider-native deferred tool
discovery (`tool_search`, `defer_loading`, or `additional_tools`) or explicit
prompt-cache breakpoints. AI SDK core generation is adapter-neutral, so native
support must be attributed to a concrete adapter rather than to `ai` in
general. The 2026-07-17 audit used `ai@7.0.30`, `@ai-sdk/provider@4.0.3`,
`@ai-sdk/openai-compatible@3.0.11`, `@ai-sdk/openai@4.0.15`, and
`@ai-sdk/anthropic@4.0.15`; adapter and core versions are part of the capability
tuple rather than evidence by themselves. The audited `@ai-sdk/openai@4.0.15`
[`Responses adapter`](https://github.com/vercel/ai/blob/b8241a6e5592066c0ee1772c32d3ef47d7d7595e/packages/openai/src/tool/tool-search.ts)
exposes `openai.tools.toolSearch`; its Responses tool preparation maps
[`providerOptions.openai.deferLoading` to `defer_loading`](https://github.com/vercel/ai/blob/b8241a6e5592066c0ee1772c32d3ef47d7d7595e/packages/openai/src/responses/openai-responses-prepare-tools.ts).
The audited
[`@ai-sdk/anthropic@4.0.15` adapter](https://github.com/vercel/ai/blob/6976682b5718f36425521816e6a8c2df8c07faa9/packages/anthropic/src/anthropic-prepare-tools.ts)
maps `providerOptions.anthropic.deferLoading` into Anthropic tool definitions.
A host may explicitly configure those adapter paths, but PSS does not create or
replay their provider-specific transcript items. This is not a claim that PSS
implements client-executed OpenAI tool search or Anthropic reference replay.

`@ai-sdk/openai-compatible` is a different, generic adapter. It has no general
contract to preserve every router/vendor extension, so neither an official
OpenAI/Anthropic adapter implementation nor a compatible model ID establishes
native deferred-tool support on that path. Broader adapter-agnostic dynamic
selection remains discussed in AI SDK
[#11920](https://github.com/vercel/ai/issues/11920). Provider-native
just-in-time retrieval is therefore a separate, capability-gated layer.
[OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
is documented for GPT-5.4 and later. Hosted search returns
`tool_search_call`/`tool_search_output` in the same response with
`execution: "server"` and a null `call_id`. Client-executed search stops after a
call with `execution: "client"`; the application must return a later
`tool_search_output` with the same non-null `call_id`. PSS does not currently own
that client round trip. A future client path must constrain returned definitions
to a host-owned allowlist or registry subset and fail closed on unexpected
names, types, duplicates, or schemas. Both modes load selected definitions at
the end of the current context. An `additional_tools` item instead makes tools
available at its exact input position; manual replay must preserve that position
and `role: "developer"`. Changing or removing a loaded set breaks cache reuse
from that point forward.

An individually deferred function still exposes its name and description at the
start of the request, so in practice it mostly defers the parameter schema.
Namespaces and MCP servers initially expose only their container name and
description and can produce more material savings. OpenAI recommends those
grouped surfaces where possible and, as a best practice, fewer than ten
functions per namespace. Tool search may reduce token use and cost; deferral is
not an authorization or secrecy boundary.

[Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool.md)
uses `defer_loading` plus `tool_reference` expansion and requires unchanged
search-result/reference blocks when replaying history. Deferred definitions
are still sent in the request's top-level `tools` array; they are omitted only
from the initial model-visible context prefix, so deferral is neither an
authorization boundary nor a secrecy mechanism. Anthropic's native support
matrix includes Haiku 4.5; that should not be conflated with third-party custom
message-anchored implementations that may support a narrower model set.

As of the 2026-07-17 upstream audit (Pi main
[`216e672`](https://github.com/badlogic/pi-mono/commit/216e672)), Pi's
additive-only prototype
([`3d8f743`](https://github.com/badlogic/pi-mono/commit/3d8f743))
records added tool names in tool results and replays provider-native references
at the exact load point, while removal or other non-additive changes fall back
to eager tools. Current OpenCode
([commit `3a1c6df`](https://github.com/anomalyco/opencode/commit/3a1c6df)) exposes a
cache marker/key path but no native tool-search replay. Those designs reinforce
the boundary here: the generic selector owns deterministic eager membership;
an adapter-specific future layer would own transcript-anchored loading.

Pi main also contains a separate, direct-Kimi compatibility path in
[`f16b4e0cda56cef74bb92e264f8561cf8f4c1385`](https://github.com/badlogic/pi-mono/commit/f16b4e0cda56cef74bb92e264f8561cf8f4c1385)
and
[`70c57632975c989f80a3a49c79ff43213f1f1dad`](https://github.com/badlogic/pi-mono/commit/70c57632975c989f80a3a49c79ff43213f1f1dad).
It serializes tools into system messages only when the OpenAI Completions
adapter explicitly sets `compat.deferredToolsMode = "kimi"`. That matches
[Kimi's direct-provider protocol](https://platform.kimi.ai/docs/guide/use-dynamic-tool-loading),
which injects complete tool definitions in positioned system messages and is
currently documented only for `kimi-k3`; it is not OpenAI `tool_search`.
Pi's OpenRouter Kimi registry does not enable this mode. A Kimi-compatible name
through a router therefore must not be treated as evidence that the direct
provider extension survived routing.

Native enablement should be keyed by the full
adapter/provider/model/version tuple, then confirmed by a wire canary that
observes the expected native request and replay items. Unknown tuples, failed
canaries, model aliases, and router paths should fall back to the deterministic
eager PSS selection implemented here. Model-name detection alone is not a safe
capability check.

The canary must cover approval policy as well as wire shape. OpenAI's current
[MCP guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
says the API defaults to approval before sharing data, while the pinned
`@ai-sdk/openai@4.0.15` Responses preparation code serializes an omitted
adapter option as
`require_approval: "never"`. A native PSS integration must therefore require an
explicit host-owned approval policy and verify the serialized value; it must
not inherit either side's default for sensitive tools. OpenAI does not store MCP
`authorization` or include it in the Response, so every native Responses request
must re-inject it from a host credential source rather than a transcript or
evidence record. The same canary must verify `allowed_tools`; returned tools and
output remain untrusted input across durable resume.

Both providers' prompt-cache documentation keeps exact-prefix stability
central; see
[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
and [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
OpenAI additionally documents `prompt_cache_key` and explicit cache breakpoints
for GPT-5.6 and later, including separately reported cache-write tokens and
write cost. These provider-native controls are not silently synthesized by the
generic OpenAI-compatible path. As rechecked on 2026-07-17, the
[prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching#prompt-cache-breakpoints)
says cache reads consider the latest 50 breakpoints, while the
[Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
says the latest 80 without a content-block lookback limit. This runtime does not
encode or claim either disputed limit.
[`@ai-sdk/openai-compatible` 3.0.11](https://github.com/vercel/ai/blob/b8241a6e5592066c0ee1772c32d3ef47d7d7595e/packages/openai-compatible/src/chat/convert-openai-compatible-chat-usage.ts)
parses `cached_tokens` but not
`cache_write_tokens`: the latter can remain only in `usage.raw`, normalized
`cacheWrite` stays absent, and normalized `noCache` includes those writes. A
custom `convertUsage` or a provider-specific adapter is required before using
normalized usage for GPT-5.6 cache economics; read-hit telemetry alone is not a
cost claim.

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

Every successful agent-loop model attempt emits a metadata-only `model-usage`
event before its generated message events. It normalizes the AI SDK fields as
`attemptId`, `provider`, `modelId`, `finishReason`, `durationMs`, `inputTokens`,
`cacheReadTokens`, `cacheWriteTokens`, `noCacheTokens`, `outputTokens`,
`reasoningTokens`, and `totalTokens`. `durationMs` is the AI SDK response wait
time and excludes client-side tool execution; provider-reported token fields
stay absent when unsupported, preserving the difference between missing and
zero. Some adapters normalize an omitted provider field to zero before PSS sees
it. For example, `@ai-sdk/openai-compatible` 3.0.11 still maps an omitted raw
cached-token field to normalized zero. `LanguageModelUsage.raw` may retain a
provider-specific shape, but the generic PSS event intentionally reads only the
normalized adapter fields and does not expose or guess raw provider keys. The
same adapter version does not normalize raw `cache_write_tokens`; its
normalized `noCacheTokens` subtracts cache reads but can still include provider
cache writes. Treat `noCacheTokens` as adapter-normalized telemetry, not a
cross-provider billing quantity, unless the adapter's read/write semantics have
also been audited.

These fields retain inputs that overlap the audited 2026-07-16 development
[OpenTelemetry GenAI semantic-conventions snapshot](https://github.com/open-telemetry/semantic-conventions-genai/commit/33b7f9da9ade6162d4a5c16247d0bc6ad5f8b469),
including cache-creation/read input counts, model attribution, and finish
reasons. PSS prefers a provider-returned response model when available, then
falls back to final-step and configured model metadata. The `provider` and
fallback model identifiers are the adapter/client view; behind a proxy or
router they need not identify the actual upstream provider. Those conventions
moved to a separate development repository in May 2026 and do not yet publish
a stable schema URL, so this event does not claim OTel conformance or emit OTel
attributes. Its per-successful-attempt usage records are also not equivalent to
the snapshot's per-invocation inference and tool-call counts, which include
failed and partial calls. In particular, the newer
`gen_ai.conversation.compacted` signal is defined only for known-true
compaction; PSS keeps typed compaction provenance separately and does not infer
that attribute here.

`attemptId` is generated once per PSS runtime model-step invocation. It
correlates runtime telemetry and durable replay; it does not identify or count
HTTP retries hidden inside an AI SDK or provider adapter. Plugins observe the
same record through `model.usage` after the durable usage-flush boundary. A
failing observer can fail the turn without erasing an already persisted usage
record.

When the host supports durable thread-event replay, the runtime first stages
`model-usage` with pending lifecycle events and attempts the durable flush. It
then publishes the usage record to the live turn stream from a `finally`
boundary, and calls observers only after a successful durable flush. If the
durable append fails, the observer is not called and the pending buffer is
restored; turn-error recovery can persist the same usage record once, while
the failed attempt can still leave a live-only record. Durable
`thread.events()` may expose lifecycle and usage records before the terminal
thread-state commit, so replay is not proof that the generated state committed.
Later state-commit failures and retries keep the original attempt record, with
a distinct `attemptId` on the retry.

The event is scoped to attempts in the public turn loop. Internal automatic
compaction summary requests run outside that stream and do not emit it. Durable
resume retries emit one record per successful provider attempt, including an
attempt whose generated state later fails to commit and is retried. Each retry
invokes a new runtime model step and therefore receives a new `attemptId`.

`model-usage` is operational telemetry, not an exactly-once billing ledger.
There can be no local record when an SDK/provider retry is hidden from PSS, an
adapter cannot parse the response, tool-call ID post-processing fails after a
billed response, the process stops between the provider response and local
event emission, or durable persistence fails permanently. Internal automatic
compaction model calls are also outside this stream. Reconcile authoritative
billing against provider invoices or provider request IDs.

Eval cache summaries reject malformed token counts, impossible read/input
pairs, and unsafe aggregate overflow instead of clamping them. Gate both sample
size and coverage when making a cache claim:

```ts
t.cacheHitRateAtLeast(0.3, {
  minTelemetryCoverage: 0.9,
  minTrackedRequests: 10,
  warmupRuns: 1,
});
```

`minTelemetryCoverage` is the fraction of post-warmup model attempts with a
valid cache-read/input pair. It prevents a high rate from a tiny reported
subset from passing only because `minTrackedRequests` was met.

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

Compacted ranges remain typed as `CompactionContextMessage` values with
`role: "compaction"`, their summary, and source sequence range while
`model.context` handlers run. This lets a guard remove a contaminated summary
by provenance instead of matching arbitrary text. After the hook completes, the
runtime lowers each retained compaction to a user-scoped `<summary>` message at
the provider boundary; model-generated summaries are never promoted to system
instructions. User-authored text that happens to contain protocol-like literals
is not rewritten.

Use `model.step.before` to validate or transform a complete model step after
generation and before any message from that step is appended or any mapped
output event is emitted. Multiple transforms chain in plugin registration
order, and failures stop the turn without partially appending the step.

```ts
import { definePlugin } from "@minpeter/pss-runtime";

const protocolGuard = definePlugin((pss) => {
  pss.on("model.context", ({ messages }) => ({
    action: "transform",
    value: {
      messages: messages.filter(
        (message) =>
          message.role !== "compaction" || isSafeSummary(message.summary)
      ),
    },
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

Request and telemetry hooks cover these boundaries:

- `input.accept` for `user-input` and `runtime-input`
- `turn.start.before` before `turn.start`
- `model.context` before each model call
- `model.step.before` after generation and before atomic step append
- `model.usage` after a successful agent-loop model attempt and before output
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
```

`tool.call.before` events carry `toolName`, `toolCallId`, `input`, `policy`,
`attempt`, and `idempotencyKey`. Plugin handlers also receive current
model-message `history` and `signal` through `PluginEventContext`. The runtime
snapshots `tool.call.before` payloads before each plugin runs, so input mutations
do not affect later plugins or tool execution. Keep tool inputs
structured-cloneable and reasonably sized, because the runtime clones the input
once per plugin before tool execution. `transform` and `handled` returns are
not valid for `tool.call.before`; invalid decisions fail closed.

`tool.execution.start` runs only after every `tool.call.before` handler continues.
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
for PSS turn drain. `createCloudflareAgentsHost` remains a **deprecated alias** of
`createCloudflareHost` for older call sites.

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
