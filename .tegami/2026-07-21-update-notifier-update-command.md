---
packages:
  npm:@minpeter/pss-coding-agent:
    type: minor
---

## Add update notices and the `pss update` command

The TUI now checks for updates without blocking startup: a cached registry
result in `~/.pss/update-check.json` (24h TTL, written atomically) is read
before the first render, one dim scrollback line announces a newer version
when present, and a stale cache refreshes in the background after the first
render so the startup path performs no network I/O. The version and channel
(`latest` or `next`) are baked at build time, checks skip dev/source runs,
and `PSS_DISABLE_UPDATE_CHECK=1` opts out.

`pss update` re-checks the npm registry and installs the exact pinned
version through the detected package manager (pnpm/npm/bun/yarn global
installs; dlx/npx/bunx one-off runs and unknown layouts are refused with
manual instructions). Stable installs stay on `latest`, prerelease installs
stay on `next`, and `pss update --channel latest` moves a prerelease install
to stable explicitly. `pss update --check` prints the current version,
channel, install method, and the exact command without changing anything.

The TUI web-tools availability warning now renders through the same dim
scrollback seam instead of a pre-start `console.warn`.
