# pss-next

Small prototype for a minimal agent runtime: AI SDK `generateText` emits text, a tool call, or text followed by a tool call; sessions accept user messages through a queue and consumers observe progress through agent events.

```bash
pnpm install
pnpm run dev
pnpm run test
pnpm run typecheck
```

Copy `.env.example` to `.env` and set `AI_API_KEY`, `AI_BASE_URL`, and
`AI_MODEL` to configure the default OpenAI-compatible provider.
