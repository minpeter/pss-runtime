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
| `AI_BASE_URL` | no | defaults to `https://apis.opengateway.ai/v1` |
| `AI_MODEL` | no | defaults to `minimax/MiniMax-M2.7` |

## Local dev

```sh
pnpm --filter @minpeter/pss-agent-worker dev
```

`dev` starts `wrangler dev` on `http://127.0.0.1:8791`, clears any Telegram
webhook, and forwards updates via long polling. No tunnel or webhook setup is
required for local work.

## Deploy

```sh
pnpm --filter @minpeter/pss-agent-worker deploy
```

`predeploy` auto-registers Telegram webhook to `${WORKER_PUBLIC_URL}/telegram/webhook`.

## Typecheck

```sh
pnpm --filter @minpeter/pss-agent-worker typecheck
```

## Architecture

```text
Telegram -> Worker.fetch(/telegram/webhook) -> Durable Object (per chat) -> pss-runtime Agent
```