---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Preserve recovery contracts and terminal presentation

Retain queued callers across execution-start failures and preserve completed tool inputs and structured results during recovery. Keep narrow transcript tails, renderer notifications, and streamed tool previews intact.
