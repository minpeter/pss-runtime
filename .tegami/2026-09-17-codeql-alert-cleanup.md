---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Address CodeQL code scanning alerts

Decode S3 XML entities in one pass during Celld QA cleanup, and drop test-only patterns that CodeQL flagged (`cat`, identity replace, first-only `\r` strip). Remaining scanner hits were dismissed on GitHub.
