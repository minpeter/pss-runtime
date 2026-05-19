# pss-next

`pss-next` is now a Turborepo monorepo with two publishable packages:

- `@pss-next/runtime` — generic agent runtime, sessions, model loop, and event stream.
- `@pss-next/coding-agent` — coding-agent product tools plus optional TUI wiring.

The runtime stays product-agnostic. Import coding-agent tools explicitly when you
want the web search/fetch product layer.

## Development

```bash
pnpm install
pnpm dev
pnpm dev:tui
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

`pnpm dev` runs `examples/basic.ts` through the workspace package names with the
`@pss-next/source` condition, so local development uses `packages/*/src` without
publishing first.

```ts
import { tools } from "@pss-next/coding-agent";
import { Agent } from "@pss-next/runtime";

const agent = new Agent({ tools });
const session = agent.createSession();
```

## Environment

Copy `.env.example` to `.env` and set the OpenAI-compatible runtime provider:

```env
AI_API_KEY=...
AI_BASE_URL=...
AI_MODEL=minimax/MiniMax-M2.7
```

Coding-agent web tools additionally require TinyFish credentials when invoked:

```env
TINYFISH_API_KEY=tf-token-1;tf-token-2
```

`TINYFISH_API_KEY` accepts semicolon-delimited token pools. Empty segments and
whitespace are ignored, and the tools rotate usable keys across calls.

## Packages

### `@pss-next/runtime`

Use this package when you need the reusable runtime only:

```ts
import { Agent, type RuntimeLlmContext } from "@pss-next/runtime";
```

The package exposes a narrow runtime API and explicit interop aliases instead of
re-exporting broad AI SDK canary types from the root declaration.

### `@pss-next/coding-agent`

Use this package when you need the default coding tools:

```ts
import { tools, webFetchTool, webSearchTool } from "@pss-next/coding-agent";
```

The root import is side-effect-free. Launch the interactive TUI through the
subpath or the root script:

```bash
pnpm dev:tui
node --conditions=@pss-next/source --import tsx packages/coding-agent/src/tui.ts
```

## Release plan

This repo uses Changesets and public npm packages under the `@pss-next` scope.
The fallback naming plan is `@minpeter/pss-runtime` and
`@minpeter/pss-coding-agent` only if authenticated npm dry-runs prove the
`@pss-next` scope cannot publish.

Release checklist:

```bash
pnpm changeset
pnpm version-packages
pnpm install --lockfile-only
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify:release
npm pack ./packages/runtime --dry-run --json
npm pack ./packages/coding-agent --dry-run --json
npm publish ./packages/runtime --dry-run --access public
npm publish ./packages/coding-agent --dry-run --access public
```

The GitHub release workflow runs the same validation and then uses
`changesets/action` with `pnpm release`. Configure `NPM_TOKEN` in GitHub Actions
before enabling real publishes.
