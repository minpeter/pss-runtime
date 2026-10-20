---
packages:
  npm:@minpeter/pss-runtime:
    type: patch
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Durable tool rounds survive crashes

A durable thread now commits each finished tool round at step end, and every tool checkpoint journals the current step: calls recorded without an outcome and finished results not yet committed, including failed calls as their error result. A crashed run resumes from committed history plus that journal, so finished tools (including parallel siblings) never rerun and no longer park the run as `needs-recovery`; a `manual-recovery` sibling left without an outcome still parks it. `inspectDurableTurn` reports `pendingToolCalls`, which `pss exec` uses to refuse sessions that need manual recovery.
