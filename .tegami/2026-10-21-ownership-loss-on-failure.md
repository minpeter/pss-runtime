---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Report takeovers that a failure finds first

A turn whose run another process took over now reports `turn-error` with code `THREAD_OWNERSHIP_LOST` and writes nothing, even when it fails before its lease renewal notices the takeover (a model request error, or a tool checkpoint the store refuses). It used to report "History rollback persistence failed" and leave the thread handle refusing new work until restart.
