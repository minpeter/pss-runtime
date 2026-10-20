---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Document durable recovery v4

Add RFC 0006, which records the step journal, retry policies, live leases, backstops, and the SIGKILL crash matrix, with their invariants and known limits. The runtime README now points side-effect tools at a matching `retryPolicy` and names the workers that resume due work. Docs-only; no package changes.
