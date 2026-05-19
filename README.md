# pss-next

Small prototype split into a generic agent runtime and a coding-agent product
layer. The runtime owns sessions, model loops, and agent events; the coding-agent
layer owns concrete web tools and CLI/TUI product wiring.

```bash
pnpm install
pnpm run dev
pnpm run dev:tui
pnpm run test
pnpm run typecheck
```

Copy `.env.example` to `.env` and set `AI_API_KEY`, `AI_BASE_URL`, and
`AI_MODEL` to configure the default OpenAI-compatible provider. `AI_MODEL` is
pinned to `minimax/MiniMax-M2.7` by default.

The runtime does not attach product tools by default. Import coding-agent tools
explicitly when building a CLI/TUI-style agent:

```ts
import { tools } from "./src/coding-agent/tools";
import { Agent } from "./src/runtime/agent";

const agent = new Agent({ tools });
```

The coding-agent `web_search` and `web_fetch` tools require `TINYFISH_API_KEY`
when invoked.

`TINYFISH_API_KEY` accepts semicolon-delimited token pools:

```env
TINYFISH_API_KEY=tf-token-1;tf-token-2
```

Empty segments and whitespace are ignored (` a ; ; b ` becomes `a`, `b`). The
TinyFish web tools rotate usable keys across calls so quota can be spread across
the pool.

Coding-agent tools:

- `web_search` — searches with TinyFish Search API and returns ranked results.
- `web_fetch` — fetches up to 10 URLs per request with TinyFish Fetch API and
  returns extracted page content plus per-URL errors.
