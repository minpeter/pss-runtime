---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Keep hashline benchmarks compatible with Node

Patch the hashline native loader so the refreshed dependency remains usable in the repository's Node-based benchmark and test runners.
