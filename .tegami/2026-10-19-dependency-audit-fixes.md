---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Resolve dependency audit advisories

Refresh vulnerable transitive dependencies within their declared ranges, update the parent-scoped security overrides (`undici`, `sharp`), and bump the workspace `@modelcontextprotocol/client` peer to 2.2.0 so `pnpm audit --audit-level moderate` passes again. The `braces` advisory, which has no patched release and is reached only through lint tooling, is ignored explicitly. Workspace-only; published package dependency ranges are unchanged.
