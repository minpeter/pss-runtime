---
"@minpeter/pss-runtime": patch
---

Pass AI SDK `prepareStep` from `AgentOptions` through `generateModelStep` to `generateText` so hosts can set per-call `activeTools` (e.g. toolpick). Document that the outer tool loop usually keeps `stepNumber`/`steps` at 0/[] for miss-paging logic.
