---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Patch vite for GHSA-698v-4r3x-3vcv

Bump the workspace `vite` override from 8.1.0 to 8.1.6, the first release patched against GHSA-698v-4r3x-3vcv (`launch-editor` command escaping on Windows), so `pnpm audit --audit-level moderate` passes again. Vite reaches the repository only through Vitest. Workspace-only; published package dependency ranges are unchanged.
