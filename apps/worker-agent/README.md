# pss-worker-agent

Based on [minpeter-labs/cf-chat-sdk-worker-template](https://github.com/minpeter-labs/cf-chat-sdk-worker-template).

## Quick start

```bash
cp .dev.vars.example .dev.vars
# fill in .dev.vars (AI_API_KEY, TELEGRAM_*, WORKER_PUBLIC_URL)
# TELEGRAM_WEBHOOK_SECRET_TOKEN: openssl rand -hex 32
pnpm exec wrangler login   # once

pnpm -F "@minpeter/pss-worker-agent" dev    # local
pnpm -F "@minpeter/pss-worker-agent" ship   # deploy
```

After local `dev`, run `ship` again to restore the prod webhook.

## Session transport (RFC 0002 phase 1)

The initial remote submit-turn RPC is the existing authenticated tRPC mutation:

```text
POST /trpc/tui.turn
Authorization: Bearer <WORKER_AGENT_TUI_TOKEN>
```

Development accepts requests without a token; production requires the configured bearer token. `createRemoteTuiDeliveryClient()` is the supported client for this compatibility surface. It waits for the existing tool-only delivery result, so its response is a delivery result rather than an admission receipt.

RFC 0002 names the generalized transport fields as follows:

| RFC shape | Initial `tui.turn` shape | Notes |
| --- | --- | --- |
| `SubmitTurnRequest.channel` | `input.channel` | Currently restricted to `{ kind: "tui", id }`. |
| `SubmitTurnRequest.text` | `input.text` | Trimmed and rejected when empty. |
| `SubmitTurnRequest.sessionScopeKey` | `input.sessionScopeKey` | Optional and trimmed before forwarding. |
| `SubmitTurnRequest.idempotencyKey` | Not present | Added by the generalized session admission surface in a later phase. |
| `SubmitTurnResponse.accepted` | `output.delivered` | Not equivalent: `delivered` reports tool delivery after the run. |
| `SubmitTurnResponse.runId` | Not present | Added by the generalized durable-admission surface. |
| `SubmitTurnResponse.threadKey` | Implicit (`default` inside the channel DO) | Runtime naming remains `threadKey`; transport naming remains `session`. |
| `SubmitTurnResponse.eventCursor` | Not present | Clients use durable replay cursors when replay is available. |

The current route is intentionally retained while the `session` transport is added. Telegram continues to use its webhook delivery path.
