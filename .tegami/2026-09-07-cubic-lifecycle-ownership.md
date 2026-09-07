---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Preserve transcript and prompt ownership across lifecycle changes

Stage session replay before replacing the transcript, finish hidden tool results,
and stop consuming stale streams. Cancel mounted extension prompts when their
host revokes interactive access, restoring composer focus without disturbing replacements.
