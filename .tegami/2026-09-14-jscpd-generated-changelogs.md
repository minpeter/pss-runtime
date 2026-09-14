---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Stabilize duplicate-code validation

Exclude generated changelogs from duplicate-code signatures so release updates do not invalidate the source baseline.
Exercise the production exclusion with real scanner fixtures and keep the large malformed-tool-input test reliable under CI contention.
