---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Correct provider retry lifecycle

Classify a final non-retryable provider failure before retry exhaustion, and clean up pre-aborted model attempts through the normal finalization path.
