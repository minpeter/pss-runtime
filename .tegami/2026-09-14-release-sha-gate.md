---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Gate publication on the validated commit

Run the complete reusable CI gate for the release SHA before a separate least-privilege publish job, with serialized release runs and bounded job timeouts.
