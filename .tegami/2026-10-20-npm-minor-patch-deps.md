---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Update AI SDK and minor/patch dependencies

Bump the npm minor/patch dependency group, including `ai` 7.0.143 and the `@ai-sdk/*` providers. AI SDK cancellation no longer waits for in-flight tool executions, so an interrupted model step now waits for its own tool effects to settle before concluding: a tool result that lands after interruption is kept for continuation instead of forcing manual recovery.
