# pss-next

Small prototype for a minimal agent runtime: AI SDK `generateText` emits text, a tool call, or text followed by a tool call; sessions accept user messages through a queue and consumers observe progress through agent events.

```bash
pnpm install
pnpm run dev
pnpm run test
pnpm run typecheck
```

Copy `.env.example` to `.env` and set `AI_API_KEY`, `AI_BASE_URL`, and
`AI_MODEL` to configure the default OpenAI-compatible provider. `AI_MODEL` is
pinned to `minimax/MiniMax-M2.7` by default. Set `TINYFISH_API_KEY` to enable
the built-in `web_search` and `web_fetch` tools.

`TINYFISH_API_KEY` accepts semicolon-delimited token pools:

```env
TINYFISH_API_KEY=tf-token-1;tf-token-2
```

Empty segments and whitespace are ignored (` a ; ; b ` becomes `a`, `b`). The
TinyFish web tools rotate usable keys across calls so quota can be spread across
the pool.

Built-in tools:

- `web_search` — searches with TinyFish Search API and returns ranked results.
- `web_fetch` — fetches up to 10 URLs per request with TinyFish Fetch API and
  returns extracted page content plus per-URL errors.
