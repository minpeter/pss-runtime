# pss-worker-agent

Cloudflare Worker + [Chat SDK](https://chat-sdk.dev) Telegram echo bot.

Production uses Telegram webhooks. Local dev uses a poll relay that forwards `getUpdates` to `wrangler dev`, so the same webhook handler runs locally and in production.

## Setup

```bash
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars`:

- `TELEGRAM_BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
- `TELEGRAM_WEBHOOK_SECRET_TOKEN` — separate from the bot token; generate with:

  ```bash
  openssl rand -hex 32
  ```

  Telegram only allows `A-Z`, `a-z`, `0-9`, `_`, and `-`. Do not reuse `TELEGRAM_BOT_TOKEN` (it contains `:`).
- `TELEGRAM_BOT_USERNAME` (optional)
- `WORKER_PUBLIC_URL` (for `ship:webhook`)

Log in to Cloudflare once:

```bash
pnpm exec wrangler login
```

## Local dev

```bash
pnpm -F "@minpeter/pss-worker-agent" dev
```

Runs `wrangler dev` and the Telegram poll relay in parallel.

## Ship (deploy)

```bash
pnpm -F "@minpeter/pss-worker-agent" ship
```

Runs, in order:

1. `wrangler secret bulk .dev.vars`
2. `wrangler deploy`
3. Telegram `setWebhook`

When switching back from local dev to production, run `ship` (or `ship:webhook`) because the relay deletes the Telegram webhook while polling.

## Scripts

| Script | Description |
|--------|-------------|
| `dev` | Local Worker + poll relay |
| `ship` | Secrets + deploy + prod webhook |
| `ship:secrets` | `wrangler secret bulk .dev.vars` |
| `ship:worker` | `wrangler deploy` only |
| `ship:webhook` | `setWebhook` only |
| `typecheck` | TypeScript check |