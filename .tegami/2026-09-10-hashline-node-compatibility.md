---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Keep hashline benchmarks compatible with Node

Patch the hashline native loader and internal syntax-cache keys so the refreshed 18.1.5 dependency remains usable in the repository's Node-based benchmark and test runners. Development-only: no published behavior or version changes; the coding agent's existing hashline anchors and native syntax validation remain unchanged.
