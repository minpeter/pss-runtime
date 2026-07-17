# Interleaved route-aware cache-policy confirmation

This checked-in snapshot combines two preregistered live campaigns run through
the OpenAI-compatible router on 2026-07-17. Each scenario used
`uniform → route-aware → route-aware → uniform`, two replicates per arm, six
turns per run, a fresh cache-isolation marker, and exactly one HTTP attempt per
logical turn.

**Overall preregistered result: fail.**
At least one route had sufficient evidence but failed a non-regression guardrail: conversation, file-search.

Across both routes, the pooled descriptive totals measured 20.51% cache hit for route-aware versus 22.71% for uniform, with strict correctness 45.83% versus 50.00%. The pooled row is not used to accept either route.

## Per-route guardrails

| Route | Result | Strict correct, uniform → route-aware | Cache hit, uniform → route-aware | Read coverage | Tracked uncached tokens | p95 | Exact response-model attribution |
|---|---:|---:|---:|---:|---:|---:|---:|
| Ministral file search | fail | 0/12 → 0/12 | 27.75% → 24.92% | 10/10 → 10/10 | 267,061 → 297,171 | 8.860 s → 7.088 s | 100.00% → 100.00% |
| MiniMax conversation | fail | 12/12 → 11/12 | 17.68% → 16.20% | 10/10 → 10/10 | 305,187 → 338,926 | 11.266 s → 11.230 s | 100.00% → 100.00% |

Each arm must complete 12/12 turns with perfect strict correctness and exact
response-model attribution, report valid read/input pairs for at least 6 of 10
attribution-eligible warm turns (60%), and have equal tracked sample counts.
Route-aware must not regress cache hit, tracked uncached tokens, p95, strict
correctness, or length finishes. A coverage or attribution miss is
`indeterminate`, not a pass.

## Pooled descriptive totals

| Arm | Strict correctness | Token recall | Warm cache hit | Read coverage | Write coverage | Exact response model | p50 | p95 | Successful turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Uniform 60K fallback | 50.00% (12/24) | 100.00% | 22.71% | 20/20 | 0.00% | 24/24 | 5.538 s | 8.860 s | 24/24 |
| Route-aware exceptions | 45.83% (11/24) | 100.00% | 20.51% | 20/20 | 0.00% | 24/24 | 5.520 s | 10.971 s | 24/24 |

The two exceptions under test were Ministral file search at a 75K projected
high-water (versus uniform 60K) and MiniMax conversation at 75K/256 output
(versus uniform 60K/512). The JSON snapshot retains sanitized per-turn status,
latency, strict-correctness and token-recall booleans, response-model audit,
and cache read/write/input telemetry. It contains no prompt, model output, raw
request or response body, authorization header, or credential.

This remains a small router-specific measurement. Cache hit rate is reported
only where the provider returned a valid read/input pair; cache-write coverage
and totals are separate because read hit alone does not establish billed cache
economics or savings.
