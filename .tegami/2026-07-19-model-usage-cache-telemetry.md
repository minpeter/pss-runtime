---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Trace model usage and cache telemetry

Emit one metadata-only `model-usage` event for every successful model
invocation in the public agent loop. Expose the same normalized record through
the factory-plugin `model.usage` hook and durable thread event replay.

Aggregate prompt-cache telemetry at run, eval-case, and report scope. Add
`cacheHitRateAtLeast()` with warmup, minimum-sample, and attempted-request
coverage gates, and fail cache assertions closed when required telemetry is
missing or incomplete.
