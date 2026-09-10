---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Keep Worker dependency validation green

Keep the Worker tracing test double compatible with refreshed type definitions and retain the patched sharp resolution for the updated dependency graph.
