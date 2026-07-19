---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Remove legacy negative assertions and orphan probe script

Drop test-only assertions that verify already-removed legacy APIs
(`createCloudflareAgentsHost`, `PSS_SESSION_*` env aliases, object-style
plugin pipeline, legacy `llm`/`description`/`sessions` option fields) do not
exist. The APIs themselves were removed in prior releases; these negative
checks no longer guard a live migration boundary.

Also delete `scripts/probe-cache-stable-response-shape.mts`, a one-off
investigation script not referenced by any npm script or test.

No API or behavior change.
