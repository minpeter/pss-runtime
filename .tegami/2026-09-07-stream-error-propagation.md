---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Preserve model stream failures

Propagate recorded provider stream errors and missing finish events through the turn error path instead of persisting them as successful turns with only `finishReason: "error"`.
