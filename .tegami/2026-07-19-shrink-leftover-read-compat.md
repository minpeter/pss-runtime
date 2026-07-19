---
packages:
  "npm:@minpeter/pss-runtime": minor
---

## Shrink leftover read-compat defaults

Stop inventing session-index `thread_key` values from channel identity when
stored keys are missing, and stop granting resume access to owner-less runs
based only on a `parent:${owner}:` thread-key prefix.

Resume requires a present `ownerNamespace` accepted by `ownsAgentNamespace`.
Session-index write paths already pass explicit `threadKey` values.
