---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Show write paths during argument streaming

Show `write <path>` as soon as a streamed write argument exposes a nonempty path, while preserving the live input preview. Render paths literally and safely in both streaming and completed write headers.
