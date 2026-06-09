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
| `WORKER_PUBLIC_URL` | yes for deploy | `https://<worker>.<account>.workers.dev` |
| `TELEGRAM_WEBHOOK_SECRET` | no | random secret for webhook auth; defaults to bot-token derivation |
| `AI_BASE_URL` | no | defaults to `https://apis.opengateway.ai/v1` |
| `AI_MODEL` | no | defaults to `minimax/MiniMax-M2.7` |

## Local dev

```sh
pnpm --filter @minpeter/pss-agent-worker dev
```

`dev` starts `wrangler dev` on `http://127.0.0.1:8791`, clears any Telegram
webhook, and forwards updates via long polling. No tunnel or manual webhook
setup is required.

If `WORKER_PUBLIC_URL` is set in `.dev.vars`, stopping `dev` restores the prod
webhook automatically.

Use a dedicated dev bot token when possible. Local `dev` deletes the active
Telegram webhook while polling.

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