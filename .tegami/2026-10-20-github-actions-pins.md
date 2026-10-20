---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Bump pinned GitHub Actions

Move the SHA pins to `actions/setup-node` v7.1.0, `actions/upload-artifact` v7.0.2, and `github/codeql-action` v4.39.0 (each SHA verified against the upstream tag), and update the workflow policy checks that pin those exact references and the canonical CI step digests. CI-only; no package changes.
