---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Preserve CLI startup and status ownership

Honor the selected workspace and startup output stream, clear retry-only labels when no base status exists, and keep detached callbacks from observing expired busy owners.
