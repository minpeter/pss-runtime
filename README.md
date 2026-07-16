# pss-next

Small agent runtime workspace.

- `@minpeter/pss-runtime`: runtime, sessions, model loop.
- `@minpeter/pss-coding-agent`: model wiring and the `pss` TUI. It ships no
  built-in tools; pass your own tool set when needed.

## Use

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@minpeter/pss-runtime";
import { createEnv } from "@t3-oss/env-core";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ path: ".env", quiet: true, override: true });
const env = createEnv({
  runtimeEnv: process.env,
  server: {
    AI_API_KEY: z.string().trim().min(1),
    AI_BASE_URL: z.url().trim().default("https://apis.opengateway.ai/v1"),
    AI_MODEL: z.string().trim().min(1).default("minimax/MiniMax-M2.7"),
  },
});

const provider = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
});

const agent = new Agent({
  instructions: "Keep every answer under 3 lines.",
  model: provider(env.AI_MODEL),
});
const run = await agent.send("Hello");
for await (const event of run.events()) {
  console.dir(event, { depth: null });
}
```

`run.events()` is synchronized and drives the run. Consume it to let the runtime
cross lifecycle boundaries such as `turn-start`, `step-start`, and `step-end`.
Use `session.send(input)` for a new user turn. If a run is already active, the
turn is queued until the active run finishes. Use `session.steer(input)` when the
input should steer the active run; if no run is active, it starts a normal run.

```ts
const session = agent.session("default");
const run = await session.send("Write a two sentence summary.");
let addedConstraint = false;

for await (const event of run.events()) {
  if (event.type === "step-end" && !addedConstraint) {
    addedConstraint = true;
    await session.steer("Keep the second sentence under 10 words.");
  }
}
```

The guard matters. `step-end` runtime input asks the runtime to continue the
current turn before the next model snapshot, even after final-looking assistant
text. Adding input on every `step-end` can keep a turn running indefinitely.

Steering additions appear as `runtime-input` events: runtime/API-originated input
mapped internally to the model's user role, separate from human `user-text` and
`user-message` events.

The runtime `send` API also accepts JSON-serializable multimodal content parts
for model providers that support them:

```ts
await agent.send([
  { type: "text", text: "What changed in this screenshot?" },
  { type: "file", data: "data:image/png;base64,...", mediaType: "image/png" },
]);
```

Inline image/file bytes and base64 data URLs are staged into the runtime's
`attachmentStore` before thread state is committed. Durable events and snapshots
store only internal `pss-attachment:` refs, and the runtime hydrates those refs
back into bytes immediately before calling the model. Custom hosts that accept
byte inputs must provide an `attachmentStore` with `put`, `get`, and `delete`;
remote `http(s)` media stays as a provider URL/reference and is not fetched by
the runtime.

Run the TUI:

```sh
pnpm dlx @minpeter/pss-coding-agent
```

or install it:

```sh
pnpm add -g @minpeter/pss-coding-agent
pss
```

In the `pss` TUI, submitting while a run is active steers the current run.
Submitting while idle starts a normal new turn.

## Develop

Use Node.js 24 or later. The repository's supported development version is
recorded in `.node-version`.

```sh
pnpm install
pnpm dev
pnpm dev:tui
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

## Env

Copy `.env.example` to `.env`.

```env
AI_API_KEY=...
AI_BASE_URL=...
AI_MODEL=...
```

The `pss` TUI enables OpenSearch-backed `web_search` and `web_fetch` tools by
default. Applications can still provide their own tools explicitly to the runtime
or TUI entrypoint.

The `pss` TUI stores sessions in `~/.pss/sessions` by default. Override with
`PSS_SESSION_DIR` and `PSS_SESSION_KEY` when you want repo-local storage or a
shared conversation key.

## Release

```sh
pnpm tegami
```

Commit the generated `.tegami/*.md` changelog with the feature or fix. On
`main`, `pnpm tegami ci` opens or updates the Version Packages pull request.
After that PR merges, the next release run publishes from the committed Tegami
publish lock using npm Trusted Publishing.
