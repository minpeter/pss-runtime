---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Remove Cloudflare host and `PSS_SESSION_*` aliases

Drop `createCloudflareAgentsHost`, `CloudflareHostAgentsOptions`, and
`CloudflareAgentsHostOptions`. Use `createCloudflareHost` /
`CloudflareHostOptions` only.

Coding-agent env falls back only on `PSS_THREAD_DIR` / `PSS_THREAD_KEY`;
`PSS_SESSION_DIR` / `PSS_SESSION_KEY` are no longer accepted.
