# pss-next

Small prototype for a minimal agent runtime: AI SDK `generateText` emits text, a tool call, or text followed by a tool call; sessions accept user messages through a queue and consumers observe progress through agent events.

```bash
pnpm install
pnpm run dev
pnpm run test
pnpm run typecheck
```

Copy `.env.example` to `.env` and set `AI_API_KEY`, `AI_BASE_URL`, and
`AI_MODEL` to configure the default OpenAI-compatible provider. Set
`TINYFISH_API_KEY` to enable the built-in `web_search` and `web_fetch` tools.

Built-in tools:

- `web_search` — searches with TinyFish Search API and returns ranked results.
- `web_fetch` — fetches up to 10 URLs per request with TinyFish Fetch API and
  returns extracted page content plus per-URL errors.
