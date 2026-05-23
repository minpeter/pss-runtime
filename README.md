# pss-next

Small agent runtime workspace.

- `@minpeter/pss-runtime` — runtime, sessions, model loop.
- `@minpeter/pss-coding-agent` — web tools, model wiring, and the `pss` TUI.

## Use

```ts
import { tools } from "@minpeter/pss-coding-agent";
import { createCodingAgentModel } from "@minpeter/pss-coding-agent/model";
import { Agent } from "@minpeter/pss-runtime";

const agent = await Agent.create({
  instructions: "Keep every answer under 3 lines.",
  model: createCodingAgentModel(),
  tools,
});
const conversation = await agent.send("Hello");
for await (const event of conversation.stream()) {
  console.dir(event, { depth: null });
}
```

The runtime `send` API also accepts JSON-serializable multimodal content parts
for model providers that support them:

```ts
await agent.send({
  type: "user-text",
  text: [
    { type: "text", text: "What changed in this screenshot?" },
    { type: "image", image: "data:image/png;base64,...", mediaType: "image/png" },
  ],
});
```

Run the TUI:

```sh
pnpm dlx @minpeter/pss-coding-agent
```

or install it:

```sh
pnpm add -g @minpeter/pss-coding-agent
pss
```

## Develop

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
TINYFISH_API_KEY=...
```

`TINYFISH_API_KEY` may contain semicolon-delimited tokens.

The `pss` TUI stores sessions in `~/.pss/sessions` by default. Override with
`PSS_SESSION_DIR` and `PSS_SESSION_KEY` when you want repo-local storage or a
shared conversation key.

## Release

```sh
pnpm changeset
pnpm version-packages
pnpm build
pnpm verify:release
pnpm release
```

Releases use Changesets and npm Trusted Publishing.
