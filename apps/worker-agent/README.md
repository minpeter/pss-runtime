# pss-worker-agent

Based on [minpeter-labs/cf-chat-sdk-worker-template](https://github.com/minpeter-labs/cf-chat-sdk-worker-template).

## Quick start

```bash
cp .dev.vars.example .dev.vars
# fill in .dev.vars (TELEGRAM_WEBHOOK_SECRET_TOKEN: openssl rand -hex 32)
pnpm exec wrangler login   # once

pnpm -F "@minpeter/pss-worker-agent" dev    # local
pnpm -F "@minpeter/pss-worker-agent" ship   # deploy
```

After local `dev`, run `ship` again to restore the prod webhook.
