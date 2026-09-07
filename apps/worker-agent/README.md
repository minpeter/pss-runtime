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

The route is intentionally retained for compatibility alongside the `session` transport. Telegram continues to use its webhook delivery path.

## Session submit and replay

Authenticated clients can use the generalized tRPC procedures at `/trpc`:

- `session.submitTurn` accepts `{ channel, text, sessionScopeKey?, idempotencyKey? }` and returns immediately after durable admission with `{ accepted: true, runId, threadKey }`.
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
in `src/observability.ts` and `src/agent/agent-otel.ts`. When milestone 4 adds
the `/healthz` route and request/turn metrics handlers, those
health/metrics/contract paths join the same include set and the floor is
re-baselined upward, never removed.

**Why not zero.** A zero or undeclared threshold passes even if the suite
stops exercising the Worker surface at all, which would let the transport,
privacy, and (once landed) health/metrics paths regress uncovered without any
signal. A non-zero floor guarantees two things: new source files enter the
measured include set instead of silently escaping it, and a deleted or
neutered test file drops measured coverage below the floor and fails the run.
The run exits 0 at or above the thresholds and non-zero below them, naming
the uncovered files and ranges.

The coverage run uses only the existing Node-environment test shims: it never
starts Wrangler dev, never calls a real provider or Telegram, and opens no
network port, so it also passes under
`PSS_TASK_VALIDATOR_NETWORK_ISOLATED=1`.
