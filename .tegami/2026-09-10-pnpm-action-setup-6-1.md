---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
---

## Update pnpm setup in GitHub Actions

Use pnpm/action-setup 6.1.0 in validation and release workflows while retaining immutable action pins.
