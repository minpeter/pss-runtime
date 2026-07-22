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
pnpm --filter @minpeter/pss-benchmark-nextjs score  # writes score.json/score.csv
```

`official` uses 24 fixtures, four runs, and early exit after the first pass. Its score is comparable to the public leaderboard. `internal` runs all four attempts and preserves pass@1-style reliability data.

The fixture source is pinned to `vercel/next.js@34d92a50266d2b70be5ac8ac147bd270f52d4a12`, and `next` is pinned to `16.3.0-canary.89` (`DEFAULT_NEXT_VERSION` in `src/constants.mjs`) because newer canaries ERESOLVE-conflict with the pinned fixture. Pass `--next-version` or set `PSS_BENCH_NEXT_VERSION` only for non-reproducible experiments.

Each result campaign contains `benchmark-manifest.json` plus agent-eval summaries and transcripts. Run `pnpm --filter @minpeter/pss-benchmark-nextjs score` to generate `score.json` and `score.csv` inside the campaign directory. Secrets are never written to the manifest.
