---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Correct provider retry lifecycle

Classify a final non-retryable provider failure before retry exhaustion, and clean up pre-aborted model attempts through the normal finalization path.
