---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Run CI on ubuntu-latest again

Revert the workflows' `runs-on` from the `instabox-k3s` runner scale set back to `ubuntu-latest`. The scale set registered no runners, so every job stayed queued, and the last jobs it did pick up failed in `Setup pnpm`. CI-only; no package changes.
