---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Crashed turns resume on their own on Celld

A host scheduler can now check each started run later through the optional `HostScheduler.scheduleBackstop` and `cancelBackstop`. A turn schedules its check 310 seconds out when it starts (inside the start's store transaction when `tx.scheduler` provides it), and settlement cancels it. `runTurnBackstop(agent, runId)` from `@minpeter/pss-runtime/execution` decides what a due check does: nothing for a settled, parked, or requeued run; check again past a live owner's lease or a busy thread; otherwise resume the run. Celld hosts implement it behind the object's alarm: `drainCelldScheduledWork` runs due checks after runs and thread prompts and reports them in `ackedBackstops` and `skippedBackstops`, so a turn whose isolate died resumes without a `thread.continue()` call. Other hosts schedule no checks.

## The TUI explains an unfinished last turn

Opening a session whose last turn never finished now says what happened after the replayed history: press Enter to continue when the turn's process is gone, that it is still running in another `pss` process, or that a tool may have partly run and new instructions are needed. The TUI never resumes the turn on its own.
