# Cache-stable dynamic tools: live-provider benchmark

This benchmark checks whether preserving the tool-definition prefix correlates
with provider-reported prompt-cache reuse. It sends OpenAI-compatible chat
completion requests directly so the raw usage shape remains observable.

It runs two paired comparisons:

1. **Same set, different order.** Each pair warms the cache with the canonical
   tool order. The measured request either preserves that order or reverses the
   exact same set.
2. **Changed active set.** Each pair warms with the full canonical set. The
   measured request either repeats that set exactly or removes a dynamic suffix
   while retaining the fixed canonical prefix.

Every arm gets a unique prompt namespace and its own warmup, preventing one arm
from inheriting another arm's cache entry. The long deterministic prefix clears
common minimum cacheable-token thresholds. Request bodies, model output, and
credentials are not written to the result. SHA-256 hashes of the serialized
request and tools array make the wire-level relationships auditable without
publishing the long prompt.

The runtime resolver behavior that constructs these two arrangements is covered
separately by `packages/runtime/src/llm/llm.test.ts`, especially “uses
alphabetical tool order by default” and “keeps always-active tools as a
canonical prefix before dynamic tools.” Those tests assert the `activeTools`
and AI SDK `toolOrder` passed to model generation. This benchmark isolates the
provider premise: what an OpenAI-compatible endpoint reports after receiving
equivalent wire arrays. It does not replace the resolver tests or claim that
the raw HTTP script exercises PSS end to end.

`scripts/cache-stable-tools-wire.test.mjs` closes that boundary locally: it
runs PSS through the OpenAI-compatible adapter with a synthetic fetch, asserts
the actual wire tool-name arrays and SHA-256 hashes across registry insertion
orders, and checks the changed active set and diagnostic fingerprints. No live
credential is needed for that deterministic smoke test.

## Reproduce

Use a disposable credential and pass it only through the environment:

```sh
read -rsp 'API key: ' CACHE_BENCH_API_KEY
export CACHE_BENCH_API_KEY
pnpm benchmark:cache-stable-tools
unset CACHE_BENCH_API_KEY
```

Run `pnpm benchmark:cache-stable-tools -- --help` for model, trial, timeout,
settling-delay, prefix-size, endpoint, and output options.

The default run uses ten sequential paired trials per model and scenario. It is
deliberately not parallelized, avoiding benchmark-induced concurrency as an
extra latency and cache-affinity variable.

## Checked-in snapshot

The 2026-07-17 KST snapshot completed all 120 warmups and all 120 measured
requests successfully. MiniMax and Mistral exposed
`prompt_tokens_details.cached_tokens`; Qwen exposed no recognized cache-read
field. No model exposed a recognized cache-write field.

| Model | Raw cache-field coverage | Same order vs reversed (median read/input) | Paired difference | Active set unchanged vs subset (median read/input) |
| --- | ---: | ---: | ---: | ---: |
| `minimaxai/minimax-m2.7` | 38/40 | 98.36% vs 72.46% | +25.90 pp for stable order (9 pairs) | 98.35% vs 96.91% |
| `mistralai/ministral-14b-latest` | 40/40 | 0.454% vs 0.454% | approximately 0 pp (10 pairs) | 0.454% vs 0.454% |
| `qwen/qwen2.5-7b-instruct` | 0/40 | not reported | not eligible | not reported |

For MiniMax, stable order also had a 4,480-token paired median advantage and
was 974 ms faster in the same-set comparison. Its weighted read/input ratios,
which retain zero-hit observations, were 89.84% stable versus 71.06% reversed.
The Mistral distribution was bimodal: occasional approximately 14k-token hits
raised weighted ratios to about 20.2%, while every arm's median remained 64
tokens. It provides no ordering evidence in this run.

The active-set absolute token difference is not an effect estimate because the
subset has a different input length. The useful MiniMax signal is coverage: the
canonical subset retained a 96.91% median read/input ratio, only 1.44 percentage
points below the unchanged control in eligible paired trials.

## Interpretation limits

- `reported-nonzero` means the endpoint returned a recognized positive
  cache-read token field. `reported-zero-only` means a raw field was present but
  zero. `not-reported` means no recognized raw field was exposed; it is not
  normalized to zero and is not proof that the upstream provider did no caching.
- The router's upstream provider, backend affinity, cache policy, load, and
  usage normalization are opaque. This is observational evidence, not a causal
  provider guarantee.
- Arm order was fixed within every trial: stable before reversed, then
  unchanged before subset. The checked-in JSON records this as
  `fixed-control-first`. Time drift or backend-affinity drift can therefore be
  confounded with arm identity. Counterbalance the order before using this as
  publication-grade causal evidence; the current snapshot is sufficient only
  as scoped implementation evidence.
- The Mistral usage totals barely changed when tools were removed, unlike the
  MiniMax totals. Cross-model token counts are provider-normalized and are not
  directly comparable.
- Latency includes router and network variance. Token reuse is the primary
  signal; latency is supporting context only.
- A result is a dated snapshot. Re-run it when router or model versions change.

The checked-in result is [`latest-freerouter.json`](./latest-freerouter.json).
