---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Preserve recovery contracts and terminal presentation

Retain queued callers across execution-start failures and preserve completed tool inputs and structured results during recovery. Keep narrow transcript tails, renderer notifications, and streamed tool previews intact.
