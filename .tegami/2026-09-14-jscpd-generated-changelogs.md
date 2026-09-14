---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Stabilize duplicate-code validation

Exclude generated changelogs from duplicate-code signatures so release updates do not invalidate the source baseline.
Exercise the production exclusion with real scanner fixtures and batch streamed tool-input previews per frame to avoid repeatedly rebuilding large partial writes.
