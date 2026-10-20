---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Wider SIGKILL crash matrix coverage

The file-host crash matrix now checks what is saved at each kill point and what the recovery model sees, and covers undeclared policies, recovery decisions, live owners, and recoveries that crash again.
