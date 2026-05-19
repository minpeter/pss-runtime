# pss-next

`pss-next` is now a Turborepo monorepo with two publishable packages:

- `@minpeter/pss-runtime` — generic agent runtime, sessions, model loop, and event stream.
- `@minpeter/pss-coding-agent` — coding-agent product tools plus optional TUI wiring.

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
`@minpeter/pss-source` condition, so local development uses `packages/*/src` without
publishing first.

```ts
import { tools } from "@minpeter/pss-coding-agent";
import { Agent } from "@minpeter/pss-runtime";

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

### `@minpeter/pss-runtime`

Use this package when you need the reusable runtime only:

```ts
import { Agent, type RuntimeLlmContext } from "@minpeter/pss-runtime";
```

The package exposes a narrow runtime API and explicit interop aliases instead of
re-exporting broad AI SDK canary types from the root declaration.

### `@minpeter/pss-coding-agent`

Use this package when you need the default coding tools:

```ts
import { tools, webFetchTool, webSearchTool } from "@minpeter/pss-coding-agent";
```

The root import is side-effect-free. Launch the interactive TUI through the
subpath or the root script:

```bash
pnpm dev:tui
node --conditions=@minpeter/pss-source --import tsx packages/coding-agent/src/tui.ts
```

## Release plan

This repo uses Changesets and public npm packages under the `@minpeter` scope:
`@minpeter/pss-runtime` and `@minpeter/pss-coding-agent`.

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
`changesets/action` with `pnpm release`. Publishing is configured for npm Trusted
Publishing/OIDC, not `NPM_TOKEN`. Before real publishes, add a Trusted Publisher
for each npm package with:

- Provider: GitHub Actions
- Organization/user: `minpeter`
- Repository: `pss-next`
- Workflow filename: `release.yml`

Trusted publishing requires GitHub-hosted runners, `permissions.id-token: write`,
Node 22.14+ and npm CLI 11.5.1+. The workflow uses Node 24 and does not store a
long-lived npm publish token.

If these packages do not exist on npm yet, create the first package versions with
a one-time interactive local publish using your npm account and 2FA, then add the
Trusted Publisher entries above before relying on the GitHub release workflow for
subsequent publishes. npm's `npm trust` configuration requires the package to
already exist on the registry.
