---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Resolve new dependency audit advisories

Advisories published for `@vitest/mocker`, `body-parser`, `fast-uri`, `undici`, and `zod` failed `pnpm audit --audit-level moderate` on every branch. This change bumps the workspace Vitest to 4.1.12, refreshes `body-parser` (2.4.0) and `fast-uri` (3.1.9) within their declared ranges, and raises the parent-scoped `undici` overrides to 6.29.1 (`@ai-sdk/provider-utils`) and 7.30.1 (`miniflare`). The zod advisory has no patched zod 3 release. Zod 3 is reached only through `@vercel/agent-eval` in the private experimental nextjs-bench, so that advisory is ignored explicitly. The change is workspace-only: published package dependency ranges are unchanged.
