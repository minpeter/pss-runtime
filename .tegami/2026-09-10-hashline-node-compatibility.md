---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Keep the edit-format comparison runnable on Node

Development-only: update the private hashline comparison to 18.1.5 with exact-version Node compatibility patches for native loading and syntax-cache keys. No published behavior or version changes; the coding agent's existing hashline anchors remain unchanged.
