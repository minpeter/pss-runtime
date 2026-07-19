---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Shrink leftover read-compat defaults

Stop inventing session-index `thread_key` values from channel identity when
stored keys are missing, and stop granting resume access to owner-less runs
based only on a `parent:${owner}:` thread-key prefix.

Resume requires a present `ownerNamespace` accepted by `ownsAgentNamespace`.
Session-index write paths already pass explicit `threadKey` values.
`canRead` / list / search share the same rule: missing `threadKey` is not readable.
