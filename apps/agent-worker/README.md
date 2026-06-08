# Agent Worker Cloudflare App

`@minpeter/pss-agent-worker` is a private Cloudflare Worker/Durable Object app
for exercising pss-runtime behavior at edge-host boundaries. It is intentionally
credential-free by default and uses deterministic models for Worker QA.

The app covers:

- Worker `GET /health`, `POST /turn`, and `GET /events` routing.
- Durable Object route isolation by tenant, user, and conversation.
- Foreground `run.events()` drain, multipart text/image/file input, plugins,
  injected tools, `toolChoice`, blocking subagents, durable background
  subagents, `background_output`, `background_cancel`, `session.steer`,
  `Agent.resume`, duplicate delivery, retry, cancellation, and app-level
  budget guards.
- Durable Object alarm draining from storage. `waitUntil()` is not used as the
  durable background execution strategy.

## Scenarios

Supported `scenario` ids:

```text
foreground-basic
multipart-input
plugin-events
tool-choice
blocking-subagent
durable-background
background-output
background-cancel
steer-step-end
duplicate-alarm
resume-retry
cancel-stale-child
request-rejection
fanout-guard
large-history-guard
checkpoint-size-guard
budget-guard
```

## Local

Run the deterministic Worker/Durable Object simulation:

```sh
pnpm --filter @minpeter/pss-agent-worker start
```

Run the focused durable edge-case script:

```sh
pnpm --filter @minpeter/pss-agent-worker start:edge-cases
```

Run app tests and Worker typecheck:

```sh
pnpm --filter @minpeter/pss-agent-worker test
pnpm --filter @minpeter/pss-agent-worker typecheck
pnpm --filter @minpeter/pss-agent-worker typecheck:worker
```

## Wrangler Dev

Run the actual Worker/Durable Object entrypoint locally:

```sh
pnpm --filter @minpeter/pss-agent-worker dev:worker
```

For a fixed port:

```sh
pnpm --filter @minpeter/pss-agent-worker exec wrangler dev --ip 127.0.0.1 --port 8791
```

Smoke it with curl:

```sh
curl -i http://127.0.0.1:8791/health

curl -i -X POST http://127.0.0.1:8791/turn \
  -H 'Content-Type: application/json' \
  --data '{"tenantId":"tenant-a","userId":"user-a","conversationId":"ticket-a","scenario":"foreground-basic","input":"hello"}'

curl -i 'http://127.0.0.1:8791/events?tenant=tenant-a&user=user-a&conversation=ticket-a'
```

Local Wrangler persistence can be reset with:

```sh
rm -rf apps/agent-worker/.wrangler
```

## Dry-Run Bundle

Bundle without deploying or requiring account traffic:

```sh
pnpm --filter @minpeter/pss-agent-worker dry-run:worker
```

Equivalent explicit command:

```sh
pnpm --filter @minpeter/pss-agent-worker exec wrangler deploy --dry-run --outdir /tmp/pss-agent-worker-dry-run
```

Reset dry-run output with:

```sh
rm -rf /tmp/pss-agent-worker-dry-run
```

## Real Deploy

Real deploy is manual and account-owned. Prerequisites:

- Cloudflare account access and a valid Wrangler login.
- Confirm `wrangler.jsonc` uses the intended Worker name, compatibility date,
  `AGENT_DURABLE_OBJECT` binding, and Durable Object migration.
- Re-check current Cloudflare limits before raising stress budgets.

Deploy:

```sh
pnpm --filter @minpeter/pss-agent-worker deploy:worker
```

CI and repository tests do not send real Cloudflare account traffic and do not
run production deploys.

## Budgets And Limits

Default app budgets are deliberately below platform limits:

- request body: 32 KiB
- request headers: 16 KiB
- fanout: 6
- summary events: 24
- checkpoint payload: 16 KiB
- history items: 32

Relevant Cloudflare docs:

- Workers limits: <https://developers.cloudflare.com/workers/platform/limits/>
- Durable Object limits: <https://developers.cloudflare.com/durable-objects/platform/limits/>
- Durable Object alarms: <https://developers.cloudflare.com/durable-objects/api/alarms/>
- Durable Object migrations: <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>
- Node.js compatibility: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/>

At the time this app was updated, Workers Free CPU was documented as 10 ms,
Workers Paid CPU could be configured up to 5 minutes, Workers memory was 128 MB,
and Workers Free subrequests were 50 per request. Durable Object alarms support
one scheduled alarm per object; app code stores multiple queued items in DO
storage and drains them idempotently from the alarm handler.

Do not use paid-plan CPU or high subrequest stress settings in default CI.
If paid-plan stress is needed later, add a separate opt-in profile and document
the account/plan assumptions next to that command.

## Optional Provider CLI

The Worker path is deterministic. The provider-backed CLI reconstruction script
is separate and optional:

```sh
pnpm --filter @minpeter/pss-agent-worker start:cli
```

Create `apps/agent-worker/.env` from `.env.example` only for that CLI path.
