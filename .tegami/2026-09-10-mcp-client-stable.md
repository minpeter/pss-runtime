---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Stable MCP client dependency

Update the workspace development MCP client from 2.0.0-beta.5 to 2.0.0 while retaining the existing patched Worker dependency resolutions. This development-only change does not bump a published package.
