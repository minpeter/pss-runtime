# Agent Worker

Cloudflare Worker + Durable Object Telegram agent on `@minpeter/pss-runtime`.

## Environment

```sh
cp apps/agent-worker/.dev.vars.example apps/agent-worker/.dev.vars
```

| Variable | Required | Notes |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | BotFather token |
| `AI_API_KEY` | yes | LLM API key |
| `EXA_API_KEY` | yes | Exa API key for `web_search` / `web_fetch` |
| `WORKER_PUBLIC_URL` | yes for deploy | `https://<worker>.<account>.workers.dev` |
| `TELEGRAM_WEBHOOK_SECRET` | no | random secret for webhook auth; defaults to bot-token derivation |
| `AI_BASE_URL` | no | defaults to `https://apis.opengateway.ai/v1` |
| `AI_MODEL` | no | defaults to `minimax/MiniMax-M2.7` |

The execution agent uses `@minpeter/pss-web-tools` with Exa search.
Set `EXA_API_KEY` in `.dev.vars` for local dev and as a Worker secret for deploy.

## Local dev

```sh
pnpm --filter @minpeter/pss-agent-worker dev
```

`predev` builds `@minpeter/pss-runtime` and runs `webhook:remove` when
`TELEGRAM_BOT_TOKEN` is set. `dev` runs `dev:*` (`dev:worker` + `dev:poll`) in
parallel on `http://127.0.0.1:8791`.

`dev:poll` long-polls Telegram and forwards updates to the local
`/telegram/webhook` route. It skips quietly when `TELEGRAM_BOT_TOKEN` is unset.
No tunnel or manual webhook setup is required.

Worker only (no Telegram poll):

```sh
pnpm --filter @minpeter/pss-agent-worker dev:worker
```

If `WORKER_PUBLIC_URL` is set in `.dev.vars`, stopping `dev` restores the prod
webhook automatically.

Use a dedicated dev bot token when possible. `webhook:remove` deletes the
active Telegram webhook while you work locally.

## Deploy

First-time Cloudflare secrets:

```sh
cd apps/agent-worker
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
pnpm exec wrangler secret put AI_API_KEY
pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET  # optional but recommended
```

Then:

```sh
pnpm --filter @minpeter/pss-agent-worker deploy
```

`predeploy` auto-registers Telegram webhook to `${WORKER_PUBLIC_URL}/telegram/webhook`
using values from `.dev.vars`.

## Test

```sh
pnpm --filter @minpeter/pss-agent-worker test
```

## Typecheck

```sh
pnpm --filter @minpeter/pss-agent-worker typecheck
```

## Architecture

```text
Local:  getUpdates -> POST /telegram/webhook -> Worker -> Durable Object -> Chat SDK -> Agent
Prod:   Telegram webhook -> POST /telegram/webhook -> Worker -> Durable Object -> Chat SDK -> Agent
```