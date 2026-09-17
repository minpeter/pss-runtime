---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Speed up pull-request validation

Keep the complete validation matrix for main and release runs while using a Node 24 full test lane and Node 26 compatibility smoke on pull requests.
