# PSS Next.js benchmark

This package runs the public [Next.js AI Agent Evals](https://nextjs.org/evals) against the local PSS coding agent through `@vercel/agent-eval`.

## Required access

Set these before a real campaign:

```bash
export AI_API_KEY='...'
export AI_BASE_URL='https://apis.opengateway.ai/v1'
export PSS_BENCH_MODEL='qwen3.8-max-preview'
```

The exact model ID and base URL must match the selected gateway. Docker must be available. Web tools are disabled inside the benchmark.

## Commands

```bash
pnpm --filter @minpeter/pss-benchmark-nextjs preflight
pnpm --filter @minpeter/pss-benchmark-nextjs eval:smoke
pnpm --filter @minpeter/pss-benchmark-nextjs eval:official
pnpm --filter @minpeter/pss-benchmark-nextjs eval:internal
pnpm --filter @minpeter/pss-benchmark-nextjs score
```

`official` uses 24 fixtures, four runs, and early exit after the first pass. Its score is comparable to the public leaderboard. `internal` runs all four attempts and preserves pass@1-style reliability data.

The fixture source is pinned to `vercel/next.js@34d92a50266d2b70be5ac8ac147bd270f52d4a12`. The first preflight resolves `next@canary` once and stores the exact version under `.artifacts/next-version.txt`; pass `--next-version` or set `PSS_BENCH_NEXT_VERSION` to override it.

Each result campaign contains `benchmark-manifest.json`, agent-eval summaries and transcripts, `score.json`, and `score.csv`. Secrets are never written to the manifest.
