# pss-next

Small agent runtime workspace.

- `@minpeter/pss-runtime` — runtime, sessions, model loop.
- `@minpeter/pss-coding-agent` — web tools, model wiring, and the `pss` TUI.

## Use

```ts
import { tools } from "@minpeter/pss-coding-agent";
import { createCodingAgentModel } from "@minpeter/pss-coding-agent/model";
import { Agent } from "@minpeter/pss-runtime";

const session = new Agent({
  model: createCodingAgentModel(),
  tools,
}).createSession();
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

## Release

```sh
pnpm changeset
pnpm version-packages
pnpm build
pnpm verify:release
pnpm release
```

Releases use Changesets and npm Trusted Publishing.
