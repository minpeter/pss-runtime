# Live prompt-cache telemetry evidence

This directory records a small live-provider campaign for the runtime
`model-usage` and eval cache aggregation added in this change. The checked-in
[snapshot](./2026-07-17-freerouter.json) contains metadata and token counts
only: no credential, prompt, request or response body, or model output.

The follow-up [long-context policy campaign](./2026-07-17-broad-context.md)
adds 144 logical eval turns executed through 173 HTTP attempts across large
repository search, long conversation, and conflicting-source research
workloads. Its [sanitized per-turn
snapshot](./2026-07-17-broad-context.json) and [visual
summary](./2026-07-17-broad-context.png) compare rewriting context every turn
with preserving a stable prefix until a projected token high-water mark. That
campaign is a raw protocol policy control, not a PSS automatic-compaction E2E
run.

The [policy-tuning follow-up](./2026-07-17-policy-tuning.md) adds another 168
logical turns / 168 HTTP attempts at 45K and 60K high-water marks plus a MiniMax
output-budget sweep. Its [sanitized snapshot](./2026-07-17-policy-tuning.json)
and [visual summary](./2026-07-17-policy-tuning.png) show a 100%-correct uniform
fallback and an exploratory route-aware composite that raises measured cache
hit to 38.34% without regressing aggregate p95. The composite was post-hoc.

The independent [interleaved confirmation](./2026-07-17-route-aware-confirmation.md)
then rejected both preregistered route-aware exceptions. The source-hashed JSON
and independently regenerated Markdown are authoritative for the exact values;
the index repeats only a verifier-bound per-route block:

<!-- route-aware-confirmation-index:start -->
| Route | Result | Strict correct, uniform → route-aware | Cache hit, uniform → route-aware | Read coverage | Tracked uncached tokens | p95 | Exact response-model attribution |
|---|---:|---:|---:|---:|---:|---:|---:|
| Ministral file search | fail | 0/12 → 0/12 | 19.13% → 23.43% | 10/10 → 10/10 | 298,913 → 303,050 | 7.792 s → 8.492 s | 100.00% → 100.00% |
| MiniMax conversation | fail | 12/12 → 11/12 | 13.26% → 29.61% | 10/10 → 9/9 | 321,586 → 272,644 | 9.880 s → 14.298 s | 100.00% → 100.00% |
<!-- route-aware-confirmation-index:end -->

The pooled result is descriptive only: each route failed its own non-regression
guardrails. File search regressed tracked uncached input and p95 while neither
arm was strictly correct; conversation regressed strict correctness and p95
despite higher cache hit and lower tracked uncached input. This counterexample
is why the evidence does not promote the post-hoc composite or a global
cache-hit target.

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
with `?? 0`. The converter source was rechecked in 3.0.11 (the latest release
on 2026-07-17) and still has the same omission-collapsing behavior.
Consequently, an individual zero in the PSS-path snapshot is ambiguous: it can
mean either an explicit upstream zero or an omitted field.

PSS preserves `undefined` when the AI SDK supplies `undefined`, but it cannot
recover information already collapsed by an adapter. Nonzero cache-read counts
are unambiguous evidence that the runtime event and eval aggregation path carry
provider cache telemetry. Provider-level missing-versus-zero audits must use a
raw protocol probe or an adapter that preserves omission.

These campaigns measured cache **reads** only. [Current OpenAI APIs](https://developers.openai.com/api/docs/guides/prompt-caching#prompt-cache-breakpoints)
can also report cache writes as `prompt_tokens_details.cache_write_tokens`
(Chat Completions) or the corresponding input-token details (Responses). The runtime
already preserves `cacheWriteTokens` when an adapter supplies it, and the new
broad-context harness parses raw write fields, but openai-compatible 3.0.11 does
not normalize them. Read hit rate alone therefore does not establish net cache
economics for providers or models that charge separately for writes. The same
OpenAI guide currently documents cache-write tokens for GPT-5.6+ at 1.25× the
standard input-token price. That pricing is model- and provider-specific; none
of these router read-token measurements is presented as a savings claim without
write telemetry and the applicable price schedule.

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

## Reproduce and verify the broad-context evidence

The checked-in [broad-context harness](../../src/broad-context-cache-benchmark.mjs)
preserves the original scenario and request construction while making its
default report metadata-only. It never writes prompts, expected tokens, raw
responses, or credentials to stdout. Inspect a deterministic fixture manifest
without a key:

```sh
PSS_LIVE_FIXTURE_ONLY=true pnpm --filter @minpeter/pss-example-evals \
  eval:cache-broad -- conversation .
```

For a live run, set the endpoint, enter the key through a hidden prompt, and
redirect the sanitized report outside the repository:

```sh
export FREEROUTER_BASE_URL=https://freerouter.minpeter.workers.dev/v1
read -rsp 'Freerouter API key: ' FREEROUTER_API_KEY
export FREEROUTER_API_KEY
PSS_LIVE_MODELS=mistralai/ministral-14b-latest \
PSS_LIVE_POLICIES=high-water-stable-prefix \
PSS_LIVE_HIGH_WATER_TOKENS=60000 \
pnpm --filter @minpeter/pss-example-evals eval:cache-broad -- \
  file-search . > /tmp/pss-broad-context.json
unset FREEROUTER_API_KEY
```

The URL validator requires HTTPS at the exact `/v1` API root and rejects URL
credentials, query data, and fragments before constructing a Bearer request.
The `/models` preflight is mandatory and fails closed unless every requested
model ID is present. It records only requested and present model IDs. The
offline verifier independently recomputes every checked-in
run, variant, uniform candidate, route-aware composite, full-coverage control,
percentile, and parent snapshot hash from per-turn metadata. It also rejects
raw prompt, response, credential, or authorization fields:

Only `policy-tuning.parentEvidenceSha256` is authenticated against the current
checked-in broad-context JSON bytes. The older
`parentEvidenceCampaignSha256`, `benchmarkSource`, and `sourceArtifacts`
entries are retained as historical provenance metadata and validated for a
sanitized bounded shape, but their original `/tmp` inputs are not checked in
and cannot be independently re-hashed now. They are not reported as currently
verified source artifacts.

```sh
pnpm --filter @minpeter/pss-example-evals evidence:verify-cache
```

The checked-in preregistered confirmation covers the two routes where the
exploratory route-aware policy differed from the uniform 60K fallback. To
repeat it, run each command once. Each command executes
`uniform → route-aware → route-aware → uniform`, with a fresh unique cache
prefix per run, and emits only sanitized metadata:

```sh
PSS_LIVE_CONFIRMATION=true \
PSS_LIVE_STEPS=6 \
PSS_LIVE_CHUNK_CHARACTERS=60000 \
PSS_LIVE_HIGH_WATER_TOKENS=75000 \
PSS_LIVE_MODELS=mistralai/ministral-14b-latest \
pnpm --filter @minpeter/pss-example-evals eval:cache-broad -- \
  file-search > /tmp/pss-confirm-file-search.json

PSS_LIVE_CONFIRMATION=true \
PSS_LIVE_STEPS=6 \
PSS_LIVE_CHUNK_CHARACTERS=60000 \
PSS_LIVE_HIGH_WATER_TOKENS=75000 \
PSS_LIVE_MODELS=minimaxai/minimax-m2.7 \
pnpm --filter @minpeter/pss-example-evals eval:cache-broad -- \
  conversation > /tmp/pss-confirm-conversation.json
```

After both one-shot campaigns complete, import them through the validator and
atomic evidence writer rather than copying or redirecting files into the
repository:

```sh
pnpm --filter @minpeter/pss-example-evals \
  evidence:assemble-cache-confirmation -- \
  /tmp/pss-confirm-file-search.json \
  /tmp/pss-confirm-conversation.json
pnpm --filter @minpeter/pss-example-evals evidence:verify-cache
```

The runner records a manifest for itself, response parser, and URL validator,
then checks the manifest again after the campaign. The assembler also records
its verifier/schema source manifest. Verification fails if the current source
corpus fixture, behavior source, ABBA order, single-attempt rule, model catalog,
usage envelope, response-model audit, successful-turn finish-reason coverage,
or generated Markdown differs. Valid
content from a missing or aliased response-model field remains in the workload
so auditing cannot change later prompts; cache aggregates include only turns
whose response model exactly matches the requested route, while mismatch and
missing counts remain explicit evidence.

The file-search command sends the current non-test runtime source corpus to the
configured endpoint. Run it only when that external-data transfer is authorized.

## Limits

This is one small, time-stamped campaign through a router, not a latency or
provider ranking. Cache population and upstream routing are nondeterministic,
sample counts are small, and latency includes external service variance. The
evidence validates telemetry propagation and aggregation; it does not promise
a particular future hit rate.
