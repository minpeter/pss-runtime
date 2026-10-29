---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
---

## Compaction commits check the turn's lease

A compaction that commits while a turn holds its run, whether it was triggered by a context overflow or by an earlier turn's background compaction, now goes through the run's lease check like the turn's other writes. When another process has taken the run over before the turn noticed, the compaction writes nothing and the turn reports `THREAD_OWNERSHIP_LOST`. Previously the compaction committed the thread, and the new owner's next commit could fail with a version conflict. A compaction that commits after the turn settled commits as before.
