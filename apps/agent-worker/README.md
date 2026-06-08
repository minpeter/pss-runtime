# Agent Worker Cloudflare App

`@minpeter/pss-agent-worker` is a private Cloudflare Worker/Durable Object app
for exercising pss-runtime behavior at edge-host boundaries. It is intentionally
credential-free by default and uses deterministic models for Worker QA.

The app covers:

- Worker `GET /health`, legacy `POST /turn` and `GET /events`, versioned
  `POST /v1/tenants/:tenantId/users/:userId/conversations/:conversationId/turn`
  and `GET /v1/tenants/:tenantId/users/:userId/conversations/:conversationId/events`,
  `POST /runs`, `GET /runs/:runId`, and `GET /runs/:runId/events` routing.
- Agent-friendly public docs at `GET /llms.txt`, `GET /docs/index.md`,
  `GET /openapi.json`, `GET /scenarios`, and `GET /scenarios/:id`.
- Optional Cloudflare Sandbox SDK demo at
  `POST /v1/tenants/:tenantId/users/:userId/sandbox/file-edit`.
- Durable Object route isolation by tenant, user, and conversation.
- Foreground `run.events()` drain, multipart text/image/file input, plugins,
  injected tools, `toolChoice`, blocking subagents, durable background
  subagents, `background_output`, `background_cancel`, `session.steer`,
  `Agent.resume`, duplicate delivery, retry, cancellation, long-running alarm
  ping-pong, per-user sandbox file editing, and app-level budget guards.
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
long-running-pingpong
user-sandbox-file-edit
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
cp apps/agent-worker/.dev.vars.example apps/agent-worker/.dev.vars
pnpm --filter @minpeter/pss-agent-worker dev:worker
```

For a fixed port:

```sh
pnpm --filter @minpeter/pss-agent-worker exec wrangler dev --ip 127.0.0.1 --port 8791
```

Smoke it with curl:

```sh
TOKEN=replace-with-local-dev-token

curl -i http://127.0.0.1:8791/health
curl -i http://127.0.0.1:8791/llms.txt
curl -i http://127.0.0.1:8791/scenarios/user-sandbox-file-edit

curl -i -X POST http://127.0.0.1:8791/turn \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"tenantId":"tenant-a","userId":"user-a","conversationId":"ticket-a","scenario":"foreground-basic","input":"hello"}'

curl -i -X POST \
  http://127.0.0.1:8791/v1/tenants/tenant-a/users/user-a/conversations/ticket-a/turn \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"scenario":"foreground-basic","input":"hello from versioned route"}'

curl -i \
  -H "Authorization: Bearer ${TOKEN}" \
  'http://127.0.0.1:8791/events?tenant=tenant-a&user=user-a&conversation=ticket-a'

curl -i \
  -H "Authorization: Bearer ${TOKEN}" \
  'http://127.0.0.1:8791/v1/tenants/tenant-a/users/user-a/conversations/ticket-a/events'

curl -i -X POST \
  http://127.0.0.1:8791/v1/tenants/tenant-a/users/user-a/sandbox/file-edit \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"filename":"hello.py","content":"print(\"hello from sandbox\")"}'

curl -i -X POST http://127.0.0.1:8791/runs \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"tenantId":"tenant-a","userId":"user-a","conversationId":"ticket-a","scenario":{"id":"long-running-pingpong","options":{"clock":"compressed","hops":6,"delayMs":60000}},"input":"exercise alarm handoffs"}'

curl -i \
  -H "Authorization: Bearer ${TOKEN}" \
  'http://127.0.0.1:8791/runs/run_0001/events?tenant=tenant-a&user=user-a&conversation=ticket-a'
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
  `nodejs_compat`, `AGENT_DURABLE_OBJECT` binding, and Durable Object
  migration.
- Set `AGENT_WORKER_TOKEN`; `GET /health` is public, but `POST /turn` and
  `GET /events`, versioned `/v1/...` routes, and `/runs` require
  `Authorization: Bearer <token>`.
- Optional paid-plan Sandbox SDK support: switch the Worker main module to
  `src/worker/sandbox-entry.ts`, add the `Sandbox` Containers/Durable Object
  binding shown below, and keep the bearer auth check enabled. Without
  `env.Sandbox`, `/v1/tenants/:tenantId/users/:userId/sandbox/file-edit`
  returns the deterministic `getSandbox`/`mkdir`/`writeFile`/`exec`/`readFile`
  operation plan instead of spawning a container.
- Re-check current Cloudflare limits before raising stress budgets.

Deploy:

```sh
pnpm --filter @minpeter/pss-agent-worker exec wrangler secret put AGENT_WORKER_TOKEN
pnpm --filter @minpeter/pss-agent-worker deploy:worker
```

Sandbox SDK opt-in `wrangler.jsonc` additions:

```jsonc
{
  "main": "src/worker/sandbox-entry.ts",
  "compatibility_flags": ["nodejs_compat"],
  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile"
    }
  ],
  "durable_objects": {
    "bindings": [
      {
        "class_name": "AgentDurableObject",
        "name": "AGENT_DURABLE_OBJECT"
      },
      {
        "class_name": "Sandbox",
        "name": "Sandbox"
      }
    ]
  },
  "migrations": [
    {
      "new_sqlite_classes": ["AgentDurableObject"],
      "tag": "v1"
    },
    {
      "new_sqlite_classes": ["Sandbox"],
      "tag": "v2"
    }
  ]
}
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
- long-running ping-pong: 6 default one-minute alarm hops, 12 hops max

The `long-running-pingpong` scenario is time-compressed for CI: it drains one
Durable Object alarm boundary per hop without sleeping in real time. Only the
first hop is scheduled by the caller; each resumed hop schedules the next one,
so the queue handoff is exercised while the six-minute elapsed marker remains
deterministic.

The Worker `alarm()` path uses the runtime drain-budget API instead of draining
an unbounded backlog in one alarm callback. The demo budget caps one alarm at 6
scheduled runs, 6 scheduled session prompts, 64 retained summary events, and a
30-second wall-clock deadline, then re-arms the Durable Object alarm when
backlog or retryable failures remain. Runtime callers can opt into
`throwOnFailure` when they want failed scheduled work to fail the alarm handler
after the continuation has been scheduled.

The `user-sandbox-file-edit` scenario models Cloudflare Sandbox SDK usage
without requiring a paid-plan Containers binding in CI. It writes
`/workspace/project/notes.md` into a storage-backed sandbox namespace derived
from `userId`, then probes a second user sandbox to prove the same path is not
readable there. In a real paid-plan Worker, the adapter point is the same
scenario boundary:

```ts
import { getSandbox } from "@cloudflare/sandbox";

const sandbox = getSandbox(env.Sandbox, `user-${userId}`);
await sandbox.mkdir("/workspace/project", { recursive: true });
await sandbox.writeFile("/workspace/project/notes.md", content);
const after = await sandbox.readFile("/workspace/project/notes.md");
```

Keep the app-level bearer auth in front of this route. Cloudflare documents
Sandbox IDs as not cryptographically secure, so the Worker must authenticate
the caller before mapping a request to a user sandbox.

Relevant Cloudflare docs:

- Agents Markdown index: <https://developers.cloudflare.com/agents/llms.txt>
- Cloudflare Agents API: <https://developers.cloudflare.com/agents/runtime/agents-api/>
- Cloudflare Sandbox SDK: <https://developers.cloudflare.com/sandbox/>
- Cloudflare Sandbox security model: <https://developers.cloudflare.com/sandbox/concepts/security/>
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
