---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Expose authoritative provider retry scheduling

Add live-only `model-retry` scheduled/started/stopped events with delay, deadline,
remaining retries, and cancellation or terminal decisions. Runtime-owned provider
retries preserve the SDK baseline; extensions and NDJSON receive the events without persisting them.
