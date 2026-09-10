---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Repository quality and release checks

Add repository quality gates and Worker route validation, with stale release-age exemptions rejected and optional dependency drift detected.
Measure complete published build output and bound unused-code and duplicate-code reports.
