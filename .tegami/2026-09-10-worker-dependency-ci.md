---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Keep Worker dependency validation green

Keep the Worker tracing test double and shared package ranges compatible with refreshed dependencies, and align the Biome schema with its upgraded CLI.
Retain the patched sharp resolution for the updated dependency graph.
