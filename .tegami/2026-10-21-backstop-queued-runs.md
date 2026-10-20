---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Backstops resume runs a failed resume left queued

A backstop no longer gives up on a run that went back to `queued`: when a resume fails after claiming the run (for example a transient store error), the next check resumes it instead of dropping the check, so Celld still recovers the crashed turn. A run the agent cannot resume is checked again after a full backstop delay instead of every 10 seconds, and a claimed check whose resumed turn never started is cleared once that turn ends.
