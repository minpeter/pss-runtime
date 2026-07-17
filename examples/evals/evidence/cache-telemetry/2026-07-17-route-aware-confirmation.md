# Interleaved route-aware cache-policy confirmation

This checked-in snapshot combines two preregistered live campaigns run through
the OpenAI-compatible router on 2026-07-17. Each scenario used
`uniform → route-aware → route-aware → uniform`, two replicates per arm, six
turns per run, a fresh cache-isolation marker, and exactly one HTTP attempt per
logical turn.

**Overall preregistered result: fail.**
At least one route had a directly observed correctness, completion, or comparable-metric guardrail failure: conversation, file-search.

Across both routes, the pooled descriptive totals measured 26.49% cache hit for route-aware versus 16.19% for uniform, with strict correctness 45.83% versus 50.00%. The pooled row is not used to accept either route.

## Per-route guardrails

| Route | Result | Strict correct, uniform → route-aware | Cache hit, uniform → route-aware | Read coverage | Tracked uncached tokens | p95 | Exact response-model attribution |
|---|---:|---:|---:|---:|---:|---:|---:|
| Ministral file search | fail | 0/12 → 0/12 | 19.13% → 23.43% | 10/10 → 10/10 | 298,913 → 303,050 | 7.792 s → 8.492 s | 100.00% → 100.00% |
| MiniMax conversation | fail | 12/12 → 11/12 | 13.26% → 29.61% | 10/10 → 9/9 | 321,586 → 272,644 | 9.880 s → 14.298 s | 100.00% → 100.00% |

Each arm must complete 12/12 turns with perfect strict correctness and exact
response-model attribution, report valid read/input pairs for at least 6 of 10
attribution-eligible warm turns (60%), and track the identical replicate/step
coordinates in both arms. An observed correctness or completion failure remains
a failure even when another comparison metric is indeterminate.
Route-aware must not regress cache hit, tracked uncached tokens, p95, strict
correctness, or length finishes. A coverage or attribution miss is
`indeterminate`, not a pass.

## Pooled descriptive totals

| Arm | Strict correctness | Token recall | Warm cache hit | Read coverage | Write coverage | Exact response model | p50 | p95 | Successful turns |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Uniform 60K fallback | 50.00% (12/24) | 100.00% | 16.19% | 20/20 | 0.00% | 24/24 | 5.569 s | 9.334 s | 24/24 |
| Route-aware exceptions | 45.83% (11/24) | 95.83% | 26.49% | 19/19 | 0.00% | 24/24 | 6.684 s | 9.042 s | 23/24 |

The two exceptions under test were Ministral file search at a 75K projected
high-water (versus uniform 60K) and MiniMax conversation at 75K/256 output
(versus uniform 60K/512). The JSON snapshot retains sanitized per-turn status,
latency, strict-correctness and token-recall booleans, response-model audit,
and cache read/write/input telemetry. It contains no prompt, model output, raw
request or response body, authorization header, or credential.

The independent verifier can recompute aggregates and guardrail decisions from
the recorded strict-correctness booleans, but cannot independently re-grade
strict correctness because model outputs are intentionally absent.

This remains a small router-specific measurement. Cache hit rate is reported
only where the provider returned a valid read/input pair; cache-write coverage
and totals are separate because read hit alone does not establish billed cache
economics or savings. With only 12 turns per arm, the reported p95 is the sample
maximum, fixed ABBA ordering can only partially balance time drift, and no
interval or causal/generalized policy claim is made.
