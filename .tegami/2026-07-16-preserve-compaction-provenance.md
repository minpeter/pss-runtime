---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Preserve compaction provenance until provider rendering

Expose compacted history to `model.context` as typed `role: "compaction"`
messages with their summary and source sequence range. Lower retained
compactions to user-scoped `<summary>` messages only at the provider boundary,
so model-generated summaries are not promoted to system instructions and
plugins can remove contaminated compactions without rewriting stored history.
