# pss-worker-agent

Based on [minpeter-labs/cf-chat-sdk-worker-template](https://github.com/minpeter-labs/cf-chat-sdk-worker-template).

## Quick start

```bash
cp .dev.vars.example .dev.vars
# fill in .dev.vars (AI_API_KEY, TELEGRAM_*, WORKER_PUBLIC_URL)
# TELEGRAM_WEBHOOK_SECRET_TOKEN: openssl rand -hex 32
pnpm exec wrangler login   # once

pnpm -F "@minpeter/pss-worker-agent" dev    # local
pnpm -F "@minpeter/pss-worker-agent" ship   # deploy
```

After local `dev`, run `ship` again to restore the prod webhook.

## Session transport (RFC 0002)

The initial remote submit-turn RPC is the existing authenticated tRPC mutation:

```text
POST /trpc/tui.turn
Authorization: Bearer <WORKER_AGENT_TUI_TOKEN>
```

Development accepts requests without a token; production requires the configured bearer token. `createRemoteTuiDeliveryClient()` is the supported client for this compatibility surface. It waits for the existing tool-only delivery result, so its response is a delivery result rather than an admission receipt.

The compatibility RPC differs from the implemented generalized transport:

| RFC shape | Initial `tui.turn` shape | Notes |
| --- | --- | --- |
| `SubmitTurnRequest.channel` | `input.channel` | Currently restricted to `{ kind: "tui", id }`. |
| `SubmitTurnRequest.text` | `input.text` | Trimmed and rejected when empty. |
| `SubmitTurnRequest.sessionScopeKey` | `input.sessionScopeKey` | Optional and trimmed before forwarding. |
| `SubmitTurnRequest.idempotencyKey` | Not present | Available on `session.submitTurn`. |
| `SubmitTurnResponse.accepted` | `output.delivered` | Not equivalent: `delivered` reports tool delivery after the run. |
| `SubmitTurnResponse.runId` | Not present | Returned by `session.submitTurn`. |
| `SubmitTurnResponse.threadKey` | Implicit (`default` inside the channel DO) | Runtime naming remains `threadKey`; transport naming remains `session`. |
| `SubmitTurnResponse.eventCursor` | Not present | Clients use durable replay cursors through `session.replayEvents`. |

The route is intentionally retained for compatibility alongside the `session` transport. Telegram continues to use its webhook delivery path. When the channel Durable Object is unreachable, rejects the fetch, or answers non-OK, `tui.turn` answers 502 `agent durable object unavailable`; any other unexpected failure answers a generic 500 `internal error` envelope. Neither shape echoes request content or internal detail.

## Session submit and replay

Authenticated clients can use the generalized tRPC procedures at `/trpc`:

- `session.submitTurn` accepts `{ channel, text, sessionScopeKey?, idempotencyKey? }` and returns immediately after durable admission with `{ accepted: true, runId, threadKey, eventCursor? }`. `eventCursor` is optional and present only when the durable admission returns one; do not poll it — clients rely on durable replay cursors through `session.replayEvents` (below). Repeating a submission with the same `idempotencyKey` is collapsed into the original admission: the response replays the same `runId`/`threadKey` instead of failing.
- `session.replayEvents` accepts `{ channel, after?, limit?, sessionScopeKey? }` and returns committed runtime thread events plus the last `nextCursor` in the page.

Cursor polling through `session.replayEvents` is the baseline reconnect mechanism. Store the latest event cursor, pass it as `after`, and repeat; replay is exclusive of that cursor, so reconnect does not duplicate the last processed event. Replay reads `ThreadHandle.events({ after, limit })` from the runtime's canonical durable thread event history, not a projected `ThreadStore` snapshot.

## Optional SSE stream

Browser-like clients may additionally connect to:

```text
GET /session/events?channel=tui%3Alocal&after=<serialized-cursor>
Authorization: Bearer <WORKER_AGENT_TUI_TOKEN>
Accept: text/event-stream
```

The stream replays committed events after `after` before waiting for newly committed events. Each `thread-event` frame has the serialized cursor as its SSE `id` and a `StoredThreadEvent` JSON object as `data`. `streamRemoteSessionEvents()` reconnects a dropped response with its last received cursor. SSE is an optimization only: clients must retain cursor-polling replay as the deployment-neutral fallback.

The route answers 200 with `content-type: text/event-stream; charset=utf-8`, `cache-control: no-cache, no-transform`, and `connection: keep-alive` (the app sets all three; workerd strips the hop-by-hop `connection` header on the wire, where HTTP/1.1 keep-alive is the default). Failures short-circuit in a fixed precedence with no Durable Object fetch: non-GET → 405 `method not allowed`; failed bearer auth → 401 `unauthorized`; missing `channel` → 400 `channel required`; unparseable `channel` or malformed `after` (only `^(0|[1-9]\d*)$` safe integers) → 400 `invalid session event stream`. Without `after` the stream replays from the beginning; reconnecting with `after=<last id>` never redelivers that event. A trimmed non-empty `sessionScopeKey` query parameter is forwarded to the Durable Object; a blank one is omitted. When the channel Durable Object is unreachable the route answers 502 `agent durable object unavailable` before any SSE frame is sent.

## OpenAPI contract

The public HTTP surface (health probe, tRPC procedures, SSE stream, and the
Telegram webhook catch-all, each with its auth rule) is documented as an
OpenAPI 3 contract in `docs/worker-api-contract.openapi.yaml`. The committed
observed-behavior records in `docs/worker-api-contract.observations.json` are
pinned to real route behavior by `src/api-contract-observations.test.ts`, and
the contract gate fails on any documented-but-unreproduced or
observed-but-omitted behavior:

```bash
pnpm check:worker-api-contract
```

## Health probe

Unauthenticated liveness probe, dispatched before tRPC/SSE/Telegram:

```text
GET /healthz        # also /healthz/ (trailing slash)
```

Returns 200 `application/json` with a bounded (<1 KiB), deterministic body:
`environment` (the `ENVIRONMENT` binding), `version` (the
`CF_VERSION_METADATA.id` when bound, otherwise `null`), and `agentDo` (a
boolean reflecting `AGENT_DO` binding presence only — no Durable Object
fetch or wake-up). Non-GET methods return 405. A missing or invalid
baseline binding returns 503 with an opaque `{"error":"unavailable"}`
body; detail stays in structured worker logs. The probe performs no model,
Telegram, or Durable Object calls. Any sub-path (`/healthz/foo`) is not
health and falls through to the catch-all dispatch.

## Privacy, retention, and masking

- The transport persists only channel/session metadata plus durable thread
  events, all in Worker-owned Durable Object SQLite storage; there is no
  external database or retention service.
- Observability never contains message text: wide events, metrics, and spans
  carry counts, ids, tool names, and token usage only. Attachments are logged
  as `count`, `mediaTypes`, and `payloadBytes`; user-supplied filenames are
  never emitted.
- The Telegram ingress dry-run batch summary logs a bounded text preview,
  never the full message: text of at most 80 characters is logged in full;
  longer text is truncated to the first 77 characters, trimmed of trailing
  whitespace, and suffixed with `...`, so the preview is always at most 80
  characters. The full length appears only as the `textChars` count.
- Local dry-run verification never needs real Telegram egress: set
  `TELEGRAM_API_BASE_URL` (documented in `.dev.vars.example`) to a loopback
  recorder (`pnpm dev:recorder`, or `node scripts/loopback-recorder.mjs
  --port <port> --log <file>` for custom paths), and every Bot API call
  (`getMe`, `sendMessage`) is recorded locally instead of leaving the
  machine. Never set it in production.
- The webhook secret check is fully local and egress-free. A POST to the
  webhook catch-all with a missing or incorrect
  `x-telegram-bot-api-secret-token` returns 401 `Invalid secret token` from
  the adapter before any Telegram API call, Durable Object hop, or provider
  request — no real `setWebhook`/`sendMessage`/`getUpdates` ever fires. Local
  verification uses only the documented placeholder
  `TELEGRAM_WEBHOOK_SECRET_TOKEN` value from `.dev.vars.example` (a non-secret
  dummy, never a real credential, never logged); the negative case needs at
  most that placeholder and no real `.dev.vars` secret. A valid placeholder
  secret plus `TELEGRAM_INGRESS_DRY_RUN=1` yields the `Layer 1 only` dry-run
  summary reply with no agent delivery.
- Durable event history has no TTL or expiry, and the transport exposes no
  delete/clear/expire route. The evlog worker logger is initialized with
  `redact: true`, so configured secret values are never written to logs.

See
[docs/runbooks/worker-privacy-retention.md](../../docs/runbooks/worker-privacy-retention.md)
for the full privacy/retention runbook, including the local verification
procedures.

## Coverage gate

The Worker package owns its coverage gate, independent of the root core-only
coverage config (`vitest.coverage.config.ts` covers only `packages/runtime`
and `apps/coding-agent` and never references this package). Run it with:

```bash
pnpm --filter @minpeter/pss-worker-agent test:coverage
```

The gate is declared in `vitest.config.ts` under `coverage` and reports to the
gitignored `coverage/worker/` directory. Its scope is explicit: it measures
`src/**/*.ts` and excludes tests (`*.test.ts`, `*.test-support.ts`), the
`src/testing/` test shims (`cloudflare:workers`, `agents`, and image-codecs
stubs), and generated files (`*.d.ts`, `*.generated.ts`).

Minimum thresholds (percent): statements 50, branches 45, functions 48,
lines 50.

**What the minimum covers.** The floor is calibrated a few points below the
measured coverage of the existing suite so the gate is meaningful without
being flaky. That suite exercises the additive Worker surface end to end
without external services: the session contract and replay paths, the SSE
event stream, tRPC auth and dispatch, Telegram delivery and fragment
coalescing, attachment limits, and the OpenTelemetry metrics instrumentation
in `src/observability.ts` and `src/agent/agent-otel.ts`, and the `/healthz`
route in `src/health/`. When milestone 4 adds the request/turn metrics
handlers, those metrics/contract paths join the same include set and the
floor is re-baselined upward, never removed.

**Why not zero.** A zero or undeclared threshold passes even if the suite
stops exercising the Worker surface at all, which would let the transport,
privacy, health, and (once landed) metrics paths regress uncovered without any
signal. A non-zero floor guarantees two things: new source files enter the
measured include set instead of silently escaping it, and a deleted or
neutered test file drops measured coverage below the floor and fails the run.
The run exits 0 at or above the thresholds and non-zero below them, naming
the uncovered files and ranges.

The coverage run uses only the existing Node-environment test shims: it never
starts Wrangler dev, never calls a real provider or Telegram, and opens no
network port, so it also passes under
`PSS_TASK_VALIDATOR_NETWORK_ISOLATED=1`.
