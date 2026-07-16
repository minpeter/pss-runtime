# Live prompt-cache telemetry evidence

This directory records a small live-provider campaign for the runtime
`model-usage` and eval cache aggregation added in this change. The checked-in
[snapshot](./2026-07-17-freerouter.json) contains metadata and token counts
only: no credential, prompt, request or response body, or model output.

## Method

The campaign ran on 2026-07-17 against the OpenAI-compatible Freerouter
endpoint recorded in the snapshot. A random marker made every campaign prefix
unique, while the prefix stayed byte-stable within a campaign.

- **PSS path:** three models, five turns per model, 180 stable instruction
  lines, and one successful model attempt per turn. The first turn is excluded
  from the steady-state aggregate. Events were collected through the real PSS
  agent and eval harness, not a mock.
- **Raw policy control:** ten direct protocol requests compared a summary
  rewritten every turn, a summary rewritten every five turns, and a summary
  stable for all ten turns. The first request is excluded from each reported
  rate. This control establishes what the upstream response actually reported;
  it does not exercise PSS.

All requests used a maximum of eight output tokens and temperature `0.1`.

## PSS telemetry result

| Model | Warm requests | Cache read / input tokens | Warm hit rate | Wall p50 |
|---|---:|---:|---:|---:|
| `minimaxai/minimax-m2.7` | 4 | 11,638 / 24,764 | 47.00% | 4,227 ms |
| `mistralai/ministral-14b-latest` | 4 | 9,344 / 37,626 | 24.83% | 2,389 ms |
| `zai-org/glm-4.7` | 4 | 14,362 / 28,807 | 49.86% | 32,080 ms |

All 15 turns emitted a metadata-only `model-usage` event. The events carried
provider, response model, finish reason, AI SDK response duration, input,
output, reasoning, total, cache-read, and no-cache token counts. The provider
adapter and PSS event path did not surface cache-write counts. The steady-state
cache totals in the table were recomputed from those events with
`summarizeCacheUsage()`.

## Raw policy control

| Model | Rewrite every turn | Rewrite every 5 turns | Stable for 10 turns |
|---|---:|---:|---:|
| `qwen/qwen2.5-7b-instruct` | N/A | N/A | not run |
| `minimaxai/minimax-m2.7` | 0.00% | 95.21% | 99.09% |
| `mistralai/ministral-14b-latest` | 0.00% | 33.19% | 44.14% |
| `zai-org/glm-4.7` | 0.00% | 22.19% | 44.38% |
| `meta-llama/llama-4-scout-17b-16e-instruct` | 0.00% | 0.00% | 0.00% |

`N/A` means the successful upstream responses omitted the raw cached-token
field on every warm request. It is deliberately not represented as a 0% cache
hit rate. The Minimax rewrite-every-turn row has 2/9 field coverage and its
batched row has 8/9; the remaining non-Qwen rows have 9/9. Every listed policy
completed without an HTTP failure.

## Adapter boundary

The campaign used `@ai-sdk/openai-compatible@3.0.2`. Its usage converter maps
an omitted raw `prompt_tokens_details.cached_tokens` field to normalized zero
with `?? 0`. Consequently, an individual zero in the PSS-path snapshot is
ambiguous: it can mean either an explicit upstream zero or an omitted field.

PSS preserves `undefined` when the AI SDK supplies `undefined`, but it cannot
recover information already collapsed by an adapter. Nonzero cache-read counts
are unambiguous evidence that the runtime event and eval aggregation path carry
provider cache telemetry. Provider-level missing-versus-zero audits must use a
raw protocol probe or an adapter that preserves omission.

## Reproduce the PSS path

Run from the repository root. Enter the key at the hidden prompt; do not put it
in the command line or a checked-in file.

```sh
export FREEROUTER_BASE_URL=https://freerouter.minpeter.workers.dev/v1
read -rsp 'Freerouter API key: ' FREEROUTER_API_KEY
export FREEROUTER_API_KEY
pnpm --filter @minpeter/pss-example-evals eval:cache-live -- \
  minimaxai/minimax-m2.7 \
  mistralai/ministral-14b-latest \
  zai-org/glm-4.7 > /tmp/pss-live-cache-telemetry.json
unset FREEROUTER_API_KEY
```

The script writes JSON to stdout and refuses to print a report containing the
credential. It intentionally omits prompts, event bodies, and model outputs.
The defaults reproduce the five-turn PSS campaign. Override them with
`PSS_CACHE_BENCH_TURNS`, `PSS_CACHE_BENCH_WARMUP_RUNS`,
`PSS_CACHE_BENCH_PREFIX_LINES`, and `PSS_CACHE_BENCH_MAX_OUTPUT_TOKENS`.

## Limits

This is one small, time-stamped campaign through a router, not a latency or
provider ranking. Cache population and upstream routing are nondeterministic,
sample counts are small, and latency includes external service variance. The
evidence validates telemetry propagation and aggregation; it does not promise
a particular future hit rate.
