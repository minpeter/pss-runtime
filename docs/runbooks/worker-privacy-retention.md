# Worker privacy, retention, and masking

This runbook documents what the Worker transport collects, what it never
records, and how long it keeps it. It is descriptive, not aspirational: every
statement below matches the behavior implemented in `apps/worker-agent/src/`
and is pinned by worker package tests plus the probe evidence under the
gitignored `.omo/evidence/` tree. Every command runs locally against
`127.0.0.1:8792`; no external service is ever contacted.

## Minimal collection

The transport persists only channel/session metadata plus durable thread
events, all in Worker-owned Durable Object SQLite storage:

- Each per-channel Durable Object holds the runtime's durable thread event
  history in its own SQLite storage; that history is what
  `session.replayEvents` and the SSE stream replay.
- A dedicated session-index Durable Object instance holds session metadata:
  channel/conversation keys, thread key, session scope key, turn counts, and
  last-seen timestamps, plus a bounded rolling window of recent user and
  assistant text (at most 5 user and 3 assistant entries) that powers session
  list and search snippets.
- There is no external database or object store: Durable Object storage is
  the only persistence, and any hosted analytics sink is deferred and
  external (see [../deferred-controls.md](../deferred-controls.md)).

## Masking in observability

Observability never contains user or assistant message text:

- Wide events, metrics, and OpenTelemetry spans record counts, ids, tool
  names, and token usage only; the turn collector drops `user-input` and
  `assistant-output` events, so message text never reaches a log record.
- Attachments are logged as `count`, `mediaTypes`, and `payloadBytes` only;
  payload bytes and user-supplied filenames are never emitted.
- The Telegram-shaped ingress dry-run summary never logs the full message,
  only a bounded text preview: text of at most 80 characters is logged in full;
  longer text is truncated to the first 77 characters, trimmed of trailing
  whitespace, and suffixed with `...`, so the preview is always at most 80
  characters. The full length appears only as the `textChars` count.
- The worker logger initializes evlog with `redact: true`, so configured
  secret values are never written to logs. The only secret names used are
  the documented placeholders, never real values: `WORKER_AGENT_TUI_TOKEN`,
  `TELEGRAM_WEBHOOK_SECRET_TOKEN`, `TELEGRAM_BOT_TOKEN`, and `AI_API_KEY`.
  Real values live only in an untracked `.dev.vars`, never in committed
  files.

## Retention

- Durable event history lives in Worker-owned Durable Object storage with no
  TTL, no expiry, and no external retention service. Records remain until the
  deployment owner deletes the Durable Object itself, which is an external,
  deferred operation this repository never performs.
- The transport exposes no delete, clear, or expire route. The complete route
  inventory is `GET /healthz`, the tRPC procedures `session.replayEvents`,
  `session.submitTurn`, and `tui.turn` under `/trpc/*`, `GET
  /session/events`, and the webhook catch-all that never deletes anything.
  The internal session-index routes (`/session-index/upsert`, `/list`,
  `/search`, `/can-read`) are Durable-Object-internal reads and upserts,
  never deletions.
- The documentation claims no retention enforcement the Worker does not
  have: hosted retention and product analytics controls are deferred and
  external-only; see
  [../deferred-controls.md](../deferred-controls.md).

## Verifying locally

Preview boundary (offline, no ports):

- `src/telegram/telegram-ingress.test.ts` pins the exact rule so the preview
  never exceeds 80 characters: 80 characters logged in full, longer input cut
  to 77 characters plus `...` after trailing-whitespace trimming.
- `src/telegram/telegram-dry-run.test.ts` drives the real ingress coalescer
  flush in dry-run mode and asserts the logged batch summary obeys the
  boundary and never leaks the truncated tail into the log event or the
  dry-run reply.

Redaction (offline plus captured dev logs):

- `src/worker-log-client.test.ts` asserts logger initialization passes
  `redact: true`.
- Empirical proof on captured dev logs:
  1. `pnpm --filter @minpeter/pss-runtime build`
  2. Seed secret-shaped placeholder values into an untracked `.dev.vars`
     (never commit it; placeholder values only).
  3. `pnpm --filter @minpeter/pss-worker-agent dev:worker` with output
     captured to a gitignored evidence file.
  4. Run the read-only and replay probe battery (health, replay, SSE, and
     auth-failure paths) with `curl` against `127.0.0.1:8792`.
  5. Negative-grep the captured log for every seeded placeholder value; zero
     matches are required.

Route inventory cross-check: `pnpm check:worker-api-contract` compares the
documented route surface against observed behavior, and `pnpm verify:edge`
builds the unchanged edge bundle (dry-run only, never a deploy).
