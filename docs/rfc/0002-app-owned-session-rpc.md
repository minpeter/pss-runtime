---
source_issue: 172
source_url: https://github.com/minpeter/pss-runtime/issues/172
original_created_at: 2026-07-07
status: Proposed
---

> Moved from GitHub issue #172 into the repo on 2026-07-19; the issue is closed and this file is the canonical copy.

# RFC 0002: App-Owned Session RPC and Streaming Transport

| Field | Value |
|-------|-------|
| **Status** | Proposed |
| **Authors** | @minpeter |
| **Created** | 2026-07-07 |
| **Target packages** | `apps/worker-agent`, optionally examples/docs in `@minpeter/pss-runtime` |
| **Depends on** | RFC 0001 durable thread event replay for reconnect-safe streaming |

---

## Summary

RFC 0001 keeps HTTP/SSE session APIs out of `@minpeter/pss-runtime` because runtime core should stay an embed kernel, not a hosted agent server.

This RFC defines the separate app-owned transport layer: a session RPC surface for submitting turns, reading/replaying events, and optionally streaming live events over SSE/WebSocket-like transports.

The key design split:

- `@minpeter/pss-runtime` owns durable primitives: `Agent`, `ThreadHandle`, `turn.events()`, durable inbox, thread event replay.
- `worker-agent` owns HTTP/RPC/SSE transport, auth, channel/session mapping, and client UX contracts.

---

## Current State

`apps/worker-agent` already has a narrow remote TUI RPC path:

- Worker entrypoint routes `/trpc` to `handleTuiRpcRequest`.
- `tui.turn` is a tRPC mutation.
- `dispatchTuiTurn()` forwards to the target Agent Durable Object `/turn` endpoint.
- Remote clients use `createRemoteTuiDeliveryClient()` with an HTTP link.

This proves the app-owned RPC direction, but the current surface is turn-submission-oriented and not a general session transport:

- No standard session creation/open shape.
- No durable event replay endpoint.
- No live SSE stream surface.
- No shared cursor contract across TUI/webhook/browser clients.
- No explicit relationship to RFC 0001's future `thread.events({ after })` API.

---

## Goals

- Keep HTTP/SSE/RPC out of runtime core.
- Standardize app-owned session transport in `worker-agent`.
- Support submit-turn, replay-events, and optional live-stream workflows.
- Reuse RFC 0001 durable input inbox and thread event replay once available.
- Keep auth and session/channel mapping app-owned.
- Keep Telegram, TUI, and future browser clients on one transport model where practical.

## Non-Goals

- Adding HTTP/SSE APIs to `@minpeter/pss-runtime` core.
- Replacing `turn.events()` as the runtime live driver.
- Making event replay the continuation source of truth.
- Adding OpenCode-style Location, filesystem, skills, or permission policy.
- Defining a full public SaaS API.

---

## Proposed Transport Surface

### 1. Submit Turn

Submit user input to a session/channel.

```ts
interface SubmitTurnRequest {
  readonly channel: ChannelAddress;
  readonly text: string;
  readonly sessionScopeKey?: string;
  readonly idempotencyKey?: string;
}

interface SubmitTurnResponse {
  readonly accepted: true;
  readonly runId?: string;
  readonly threadKey: string;
  readonly eventCursor?: ThreadEventCursor;
}
```

Initial implementation can keep the existing `tui.turn` mutation, then generalize naming once multiple clients share it.

### 2. Replay Events

Read durable events after a cursor.

```ts
interface ReplayEventsRequest {
  readonly channel: ChannelAddress;
  readonly after?: ThreadEventCursor;
  readonly limit?: number;
  readonly sessionScopeKey?: string;
}

interface ReplayEventsResponse {
  readonly events: readonly StoredThreadEvent[];
  readonly nextCursor?: ThreadEventCursor;
}
```

This should be backed by RFC 0001 `thread.events({ after, limit })`, not by projecting `ThreadStore` snapshots.

### 3. Live Event Stream

Optional live stream for UI clients.

Transport choices:

- SSE for browser-friendly server-to-client event streams.
- tRPC subscription/WebSocket only if the deployment target and client UX justify it.
- Plain polling replay as the fallback baseline.

SSE shape:

```text
GET /session/events?channel=...&after=...
Authorization: Bearer <token>
```

The server should first replay durable events after the cursor, then stream new committed events as they arrive when supported. If the live stream drops, the client reconnects with the last durable cursor.

---

## Architecture

```text
client
  ├── submitTurn RPC
  ├── replayEvents RPC
  └── optional SSE live stream

worker-agent transport
  ├── auth / token checks
  ├── ChannelAddress -> Durable Object name
  ├── sessionScopeKey filtering
  ├── submit input to Agent Durable Object
  └── read thread event replay from runtime-backed host

@minpeter/pss-runtime
  ├── durable input inbox (RFC 0001)
  ├── thread.events({ after }) durable replay (RFC 0001)
  └── turn.events() live driver, unchanged
```

---

## Implementation Plan

| Phase | Work | Gate |
|-------|------|------|
| 1 | Document current `/trpc/tui.turn` as the initial submit-turn RPC | existing TUI remote tests |
| 2 | Add transport-level event cursor types shared by client/server | typecheck + contract tests |
| 3 | Add replay-events RPC backed by RFC 0001 thread event replay | reconnect test with cursor |
| 4 | Add SSE endpoint as an optional live stream over durable replay | reconnect + dropped-connection tests |
| 5 | Unify TUI/browser client around submit + replay + stream model | worker-agent remote eval |

---

## Open Questions

1. Should the generalized RPC keep tRPC, or expose plain JSON endpoints for easier non-TypeScript clients?
2. Should SSE be required, or should cursor replay polling be the baseline and SSE optional?
3. Should submit-turn return immediately after durable admission, or wait for tool-only delivery like current TUI behavior?
4. Should Telegram use the same replay surface internally, or remain webhook-delivery-only?
5. What is the public naming: `session`, `thread`, `channel`, or `conversation`?

---

## References

- RFC 0001: https://github.com/minpeter/pss-next/issues/171
- Existing worker entrypoint: `apps/worker-agent/src/index.ts`
- Existing tRPC router: `apps/worker-agent/src/tui-rpc.ts`
- Existing TUI dispatch: `apps/worker-agent/src/tui-server.ts`
- Existing remote TUI client: `apps/worker-agent/src/tui-remote.ts`
- Existing Durable Object request parser: `apps/worker-agent/src/agent-do-request.ts`
