---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Harden repository quality checks

Fail closed when Knip or jscpd cannot run in CI, remove an invalid retired benchmark snapshot, and resolve the remaining private benchmark dependency advisory.
