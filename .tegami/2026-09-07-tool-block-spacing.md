---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Separate tool cards from following output

Keep one blank terminal row between tool cards, including empty directory reads, and the following assistant or reasoning block without adding gaps between streamed deltas.
