# Cloudflare Edge Support Subagent Example

This example shows a support-agent style Cloudflare Worker/Durable Object
background subagent loop. The foreground agent receives a support-ticket turn,
launches compact background research, returns control to the request boundary,
then resumes from a Durable Object alarm when the child result is ready:

- `createCloudflareDurableObjectHost(...)` stores sessions, runs,
  checkpoints, events, notifications, and scheduled session prompts on a storage port
  compatible with `ctx.storage`.
- `enqueueRun(...)` and `resumeSession(...)` do not run child work inline. They
  persist scheduled work and set a Durable Object alarm.
- `AgentDurableObject.alarm()` reconstructs the agent in a later invocation,
  calls `Agent.resume(...)` for queued background runs, then resumes the parent
  notification run.
- Scheduled runs and session prompts are acked only after successful processing.
  If a resume throws, the item remains stored and the alarm is rescheduled.
- The parent and child agents use stable top-level `namespace` values so
  reconstructed agents map back to the same parent and subagent transcripts.
- Long-running Node.js remains first class in the runtime. It uses the same
  background APIs, but it can keep one process and one host instance alive.

## Run

Run the deterministic Worker/Durable Object simulation without provider
credentials:

```sh
pnpm --filter @minpeter/pss-example-cloudflare-edge-subagent start
```

Create `.env` in `examples/cloudflare-edge-subagent/` only for the
provider-backed CLI reconstruction scenario:

```sh
AI_API_KEY=...
AI_BASE_URL=https://apis.opengateway.ai/v1
AI_MODEL=minimax/MiniMax-M2.7
```

Run that edge reconstruction CLI scenario:

```sh
pnpm --filter @minpeter/pss-example-cloudflare-edge-subagent start:cli
```

Run the actual Worker/Durable Object entrypoint through Wrangler:

```sh
pnpm --filter @minpeter/pss-example-cloudflare-edge-subagent dev:worker
```

Typecheck the Worker surface with Cloudflare Worker globals:

```sh
pnpm --filter @minpeter/pss-example-cloudflare-edge-subagent typecheck:worker
```

## Durable Object Shape

The adapter consumes the same operations exposed by Cloudflare Durable Object
storage:

```ts
import { createCloudflareDurableObjectHost } from "./cloudflare-host";

const host = createCloudflareDurableObjectHost({
  storage: ctx.storage,
});
```

`wrangler.jsonc` binds `AgentDurableObject` as `AGENT_DURABLE_OBJECT`. The
default Worker `fetch` forwards requests to that Durable Object, and the DO
class owns the alarm that drains scheduled runs and session prompts.

Deploy the Worker after configuring the target account:

```sh
pnpm --filter @minpeter/pss-example-cloudflare-edge-subagent deploy:worker
```
