---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Close remaining release-policy bypasses

Allowlist the exact same-SHA build, verification, and final publish sequence, and
reject alternate publication paths or fail-open validation overrides.
