# Worker agent notes

## Metrics and wide events

The Worker owns a minimal metrics surface: structured wide log events (via
evlog) with bounded, fixed key sets, plus the OpenTelemetry spans described
below. There is no counters pipeline and no hosted metrics backend — wide
events in the Workers log stream are the metric record.

Bounded field sets per event kind:

- Request wide events: `correlationId`, `handler`, `method`, `path`,
  `status` — set on every route.
- Turn metrics (`turn:` on the agent-turn wide event, Durable Object turn
  path only): `steps` (count), `toolCalls` (tool names, deduped by
  `toolCallId`), and `errors` (`turn-error` messages only). User and
  assistant message text is never recorded: the collector drops
  `user-input` and `assistant-output` events, so wide events carry
  counts/ids/names only.
- Attachment metrics (`input.attachments`): `count`, `mediaTypes`, and
  `payloadBytes` (a byte estimate derived from the base64 length — the
  payload itself is never logged).
- Image events: prepare events carry `path` (an internal prepare-strategy
  enum, not a filesystem path), input/output byte sizes, media types,
  decoded geometry (`decodedWidth`/`decodedHeight`), `hasAlpha`, and
  `maxImageBytes`; omit events carry `limit` and `mediaType` only.
  Base64 payloads, decoded pixels, image content, and user-supplied
  filenames (which can be secret-bearing) are never recorded.

Metric emission is lazy: turn/step/tool records exist only when a turn
actually ran. Read-only probes (`/healthz`, session replay, SSE) emit only
the request wide event — zero turn-metric records. Emission never blocks or
changes request handling; the observability instrumentation yields the
event stream unchanged.

## OpenTelemetry tracing

`apps/worker-agent` wires the runtime's OpenTelemetry instrumentation into
every agent it constructs: `createConfiguredAgent` (the single factory used by
the Durable Object and the local TUI) passes
`instrumentations: [openTelemetry()]` from `@minpeter/pss-runtime/otel`. Every
`send`, `steer`, and `resume` turn is wrapped, so each turn emits a
`pss.runtime.turn` span with `pss.runtime.step` / `pss.runtime.tool` child
spans and per-event span events.

Span data is metadata only: event attributes carry counts, lengths, ids, and
token usage (for example `pss.assistant_output.text_length`), never message
text or tool payloads. Keep it that way when adding custom `eventAttributes`.

### No provider is registered by default

The worker depends on `@opentelemetry/api` only — no SDK and no exporter are
bundled. Until a deployment registers a tracer provider, `trace.getTracer()`
returns the API's built-in no-op tracer and the instrumentation is inert. This
is deliberate: the Cloudflare deployment has no tracing backend configured
yet.

### Registering a provider later

A deployment that wants these spans registers a `TracerProvider` through the
API global before any agent is constructed (worker module init or the DO
constructor's first run):

```ts
import { trace } from "@opentelemetry/api";

trace.setGlobalTracerProvider(myWorkersCompatibleProvider);
```

Requirements for the provider:

- It must implement the `@opentelemetry/api` `TracerProvider` interface and
  run in the Workers runtime (no Node-only SDK auto-instrumentation).
- Export is deployment-owned: point the provider at an OTLP/HTTP collector or
  a Workers-native tracing bridge, with whatever sampling the deployment
  wants.
- Registration is process-global and idempotent-once; do it exactly once per
  isolate. The instrumentation resolves the tracer lazily per turn, so spans
  start flowing on the next turn after registration.
