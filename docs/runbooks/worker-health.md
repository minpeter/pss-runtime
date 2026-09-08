# Worker health and operational checks

This runbook validates the Worker's health and transport surface **locally
only**, on `127.0.0.1:8792`, using replay and scripted fixtures. It never
submits a real model turn, never calls Telegram, and never deploys anything.

## Start the local Worker

The `dev:worker` script runs `wrangler dev -e dev` and binds `127.0.0.1:8792`.
Its runtime dependency is not rebuilt automatically by that script name (the
package `predev` hook pairs with the combined workspace dev script only), so
build the runtime first:

1. `pnpm --filter @minpeter/pss-runtime build`
2. `pnpm --filter @minpeter/pss-worker-agent dev:worker`

Wrangler will report that it is listening on `127.0.0.1:8792`. Use only the two
commands above for local validation. The combined workspace dev script and the
Telegram relay script are not validation steps and are never invoked here.

## Probe the health surface

With the local Worker running on `127.0.0.1:8792`, use `curl`:

- Health: `curl -s http://127.0.0.1:8792/healthz` returns a bounded JSON body
  reporting environment, version, and default-binding status, and no secrets,
  prompts, message text, or tokens.
- tRPC replay: send a replay-only request to `http://127.0.0.1:8792/trpc` with a
  scripted fixture; a real model turn is never submitted.
- SSE replay: read `http://127.0.0.1:8792/session/events` to confirm the replay
  stream, again from scripted fixtures.

For zero-egress proofs, point `AI_BASE_URL` at a loopback recorder and use the
`TELEGRAM_INGRESS_DRY_RUN` scripted fixtures for Telegram-shaped requests. The
only secret names used are the documented placeholders (`AI_API_KEY`,
`AI_BASE_URL`, `AI_MODEL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`,
`WORKER_AGENT_TUI_ENDPOINT`, `WORKER_AGENT_TUI_TOKEN`); place real values only in
an untracked `.dev.vars`, never in this runbook or any committed file.

## Lifecycle evidence procedure

Every validation run captures the same listener and lifecycle evidence around
the two startup commands above:

1. Snapshot listeners before startup with `ss -tlnp` (or
   `lsof -iTCP -sTCP:LISTEN -P -n`) and save the output.
2. Start the Worker and probe readiness: poll
   `curl -sf http://127.0.0.1:8792/healthz` until it answers. The Worker is
   expected to become ready within 60 seconds of launch; record the elapsed
   time with the probe log.
3. Run the read-only probe battery (`/healthz`, `/session/events` replay,
   `/trpc/session.replayEvents`) with no `.dev.vars` file present at all: no
   `AI_API_KEY`, no `TELEGRAM_BOT_TOKEN`, no webhook secret. The battery
   completes with the expected statuses and the wrangler log shows no outbound
   provider or Telegram request.
4. Snapshot listeners again and diff against step 1: the only added service
   listener is `127.0.0.1:8792`. Any other added sockets are attributed via
   `ss -tlnp` to the same wrangler/workerd process tree (loopback inspector
   and control plumbing) and disappear at teardown; every pre-existing
   listener is unchanged and no new container or service exists.
5. Tear down by PID, never by pattern: send SIGTERM to the wrangler parent
   PID recorded at startup, then stop any remaining workerd children by their
   recorded PIDs (a workerd child ignores SIGTERM while its wrangler parent
   lives and can respawn on a new PID if only the listener child is stopped).
   Confirm afterwards that `ss -tln` no longer shows the Worker port, that
   `ps` lists no stray wrangler or workerd process, and that
   `git status --short` is clean. `.wrangler/` working artifacts stay
   git-ignored (verifiable with `git check-ignore apps/worker-agent/.wrangler`)
   and are never committed.

## Metrics

The Worker emits OpenTelemetry spans as metadata only; see
[../worker-agent.md](../worker-agent.md) for the instrumentation contract and
how a deployment would register a tracer provider later.

## Boundaries

Production health checks and hosted uptime monitoring of the Worker are deferred
and external: they cannot be verified from repository files or local commands,
so this runbook makes no claim about a live deployment. The local counterparts
that ARE provided and validated here are the `/healthz` route and the lifecycle
evidence procedure above on `127.0.0.1:8792`, plus the Worker's own metrics
spans.
