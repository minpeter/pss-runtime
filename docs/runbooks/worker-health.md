# Worker health and operational checks

This runbook validates the Worker's health and transport surface **locally
only**, on `127.0.0.1:8792`, using replay and scripted fixtures. It never
submits a real model turn, never calls Telegram, and never deploys anything.

## Start the local Worker

The `dev:worker` script runs `wrangler dev -e dev` and binds `127.0.0.1:8792`.
Its runtime dependency is not rebuilt automatically by that script name, so
build the runtime first:

1. `pnpm --filter @minpeter/pss-runtime build`
2. `pnpm --filter @minpeter/pss-worker-agent dev:worker`

Wrangler will report that it is listening on `127.0.0.1:8792`. Use only the two
commands above for local validation. The combined workspace dev script and the
Telegram relay are not validation steps and are never invoked here.

## Probe the health surface

With the local Worker running on `127.0.0.1:8792`, use `curl`:

- Health: `curl -s http://127.0.0.1:8792/healthz` — expect a bounded JSON body
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

## Metrics

The Worker emits OpenTelemetry spans as metadata only; see
[../worker-agent.md](../worker-agent.md) for the instrumentation contract and
how a deployment would register a tracer provider later.

## Boundaries

Production health checks and hosted uptime monitoring of the Worker are deferred
and external: they cannot be verified from repository files or local commands,
so this runbook makes no claim about a live deployment. The local counterparts
that ARE provided and validated here are the `/healthz` route and the Worker's
own metrics spans.
