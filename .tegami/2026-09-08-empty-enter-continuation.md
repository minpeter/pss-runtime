---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Continue stopped unfinished tasks

Empty Enter can continue interrupted, failed, or output-limited unfinished tasks in the current live session without duplicating the user prompt or replaying completed tools. Ambiguous effects and storage failures keep an explicit recovery boundary; continuation is not restored after disposal or restart.
