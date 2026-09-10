---
packages:
  npm:@minpeter/pss-coding-agent:
    type: patch
---

## Private benchmark dependency security

Keep the private Next.js benchmark's agent-eval dependency on patched Undici and expose its existing custom-agent runner through a version-pinned export compatibility patch. This tooling-only change does not alter published coding-agent behavior.
