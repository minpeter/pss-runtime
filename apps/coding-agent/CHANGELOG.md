## @minpeter/pss-coding-agent@0.0.14-next.5 (next)

### Add hashline edit diffs to the coding-agent TUI

The coding agent now renders anchored `edit_file` results as sorted,
senpi-style word diffs with faint changed regions, stronger intra-token
highlights, and dim context rows for unchanged lines.

The TUI modules are organized by code flow under `src/tui/`, and read/diff
rendering now displays terminal control characters as safe visible
placeholders instead of forwarding them to the terminal.

## @minpeter/pss-coding-agent@0.0.14-next.4 (next)

### Add workspace coding tools and the headless `pss exec` runner

The coding agent now ships a workspace tool set shared by the TUI and a new
headless runner: `read_file`, `glob_files`, `grep_files`, `edit_file`
(hashline-anchored with stale-hash guards), `write_file`, `delete_file`, and
`shell_execute`. The file tools are confined to the workspace — path and
symlink escapes are rejected — and writes are atomic with the target
permissions applied from the outset. `shell_execute` is not a sandbox:
commands run with the user's permissions, but AI provider API keys are
withheld from the child environment.

`pss exec` runs one headless coding task for CI, benchmarks, and scripts. It
streams JSONL events (`metadata`, `agent_event`, `result`) to stdout and
exits 0 only when the task completes, with `--workspace`, exactly one of
`--prompt`/`--prompt-file`/`--stdin`, plus `--model`, `--base-url`,
`--timeout-seconds`, `--web-tools`, and `--result-file`. A `.env` next to the
working directory is loaded automatically.

Both surfaces share one production agent factory, `createCodingAgent`: the
workspace tools are always included and win name collisions, while a custom
`tools` option replaces only the optional web tools.

## @minpeter/pss-coding-agent@0.0.14-next.3 (next)

### Add update notices and the `pss update` command

The TUI now checks for updates without blocking startup: a cached registry
result in `~/.pss/update-check.json` (24h TTL, written atomically) is read
before the first render, one dim scrollback line announces a newer version
when present, and a stale cache refreshes in the background after the first
render so the startup path performs no network I/O. The version and channel
(`latest` or `next`) are baked at build time, checks skip dev/source runs,
and `PSS_DISABLE_UPDATE_CHECK=1` opts out.

`pss update` re-checks the npm registry's dist-tags and installs the
exact pinned version through the detected package manager. Channels follow
the installed version: stable installs track `latest`, and any prerelease
tracks its own dist-tag (`next`, `beta`, `canary`, or any published tag),
with explicit `--channel <tag>` moves allowed toward stable or across
prerelease channels and refused from stable to prerelease. Package managers
(pnpm/npm/bun/yarn today) are described in a single descriptor registry —
detection patterns, probes, and install arguments — so new managers are one
data entry. dlx/npx/bunx one-off runs and unknown layouts are refused with
manual instructions. `pss update --check` prints the current version,
channel, install method, and the exact command without changing anything.

With `PSS_AUTO_UPDATE=1`, an in-channel, same-major update on a
confidently detected global install is installed automatically after the TUI
exits — never during a session and never as a channel switch.

The TUI web-tools availability warning now renders through the same dim
scrollback seam instead of a pre-start `console.warn`.

## @minpeter/pss-coding-agent@0.0.14-next.2 (next)

### Remove legacy negative assertions and orphan probe script

Drop test-only assertions that verify already-removed legacy APIs
(`createCloudflareAgentsHost`, `PSS_SESSION_*` env aliases, object-style
plugin pipeline, legacy `llm`/`description`/`sessions` option fields) do not
exist. The APIs themselves were removed in prior releases; these negative
checks no longer guard a live migration boundary.

Also delete `scripts/probe-cache-stable-response-shape.mts`, a one-off
investigation script not referenced by any npm script or test.

No API or behavior change.

## @minpeter/pss-coding-agent@0.0.14-next.1 (next)

### Remove Cloudflare host and `PSS_SESSION_*` aliases

Drop `createCloudflareAgentsHost`, `CloudflareHostAgentsOptions`, and
`CloudflareAgentsHostOptions`. Use `createCloudflareHost` /
`CloudflareHostOptions` only.

Coding-agent env falls back only on `PSS_THREAD_DIR` / `PSS_THREAD_KEY`;
`PSS_SESSION_DIR` / `PSS_SESSION_KEY` are no longer accepted.

# @minpeter/pss-coding-agent

## 0.0.13

### Patch Changes

- Updated dependencies [496e522]
- Updated dependencies [7c4bb7e]
- Updated dependencies [d8e36b7]
  - @minpeter/pss-runtime@0.2.0

## 0.0.12

### Patch Changes

- bf07086: Add `help`/`--help`/`-h` to the `pss` CLI and make unknown commands print usage and exit with code 1 instead of throwing.
- 4c50311: Add local thread compaction configuration and inspection support to the coding
  agent CLI.

  The TUI now shows the active thread key and auto-compaction policy, accepts
  `PSS_THREAD_*` storage settings with legacy `PSS_SESSION_*` aliases, and can
  enable runtime auto-compaction through `PSS_AUTO_COMPACTION_MIN_MESSAGES` plus
  `PSS_AUTO_COMPACTION_RETAIN_MESSAGES`. The CLI also adds `pss inspect-thread`
  for checking the configured local thread file without starting the TUI. The
  coding agent now uses the runtime Node platform host and runtime-owned file
  thread inspection helper for local thread storage.

- 617b9f9: Refresh dependencies across the v0.1 workspace, including AI SDK 7 latest.
- e8bd679: Remove the built-in web tools from the coding-agent package and TUI. Callers can still pass their own tools through `@minpeter/pss-runtime`.
- Sync dependency updates from main into the v0.1 prerelease line.
- 1dd09de: Replace the public `agent.session(key)` entrypoint with `agent.thread(key)`.
  Threads are the app-facing conversation unit; runtime session state remains an
  internal storage concern behind the thread handle. `agent.thread({ key, scope })`
  now provides an optional scoped address for multi-user integrations while
  preserving opaque session storage under the host boundary.

  Rename execution, Cloudflare scheduling, and notification APIs from
  `sessionKey`/`resumeSession`/scheduled session prompts to
  `threadKey`/`resumeThread`/scheduled thread prompts so edge apps can model
  linear conversation history without leaking storage-session terminology.

- Updated dependencies [e989f88]
- Updated dependencies [5cc6285]
- Updated dependencies [4a2ab2b]
- Updated dependencies [d1c015c]
- Updated dependencies [74dc8de]
- Updated dependencies [320c01c]
- Updated dependencies [617b9f9]
- Updated dependencies [b03d3ac]
- Updated dependencies [836a1c4]
- Updated dependencies [1f3a46c]
- Updated dependencies [41736e7]
- Updated dependencies [7346750]
- Updated dependencies [b21c318]
- Updated dependencies [fedd6be]
- Updated dependencies [b03d3ac]
- Updated dependencies [0ffe9e7]
- Updated dependencies [515b089]
- Updated dependencies [c8bf377]
- Updated dependencies [a5418f0]
- Updated dependencies [ae58a13]
- Updated dependencies [f3c4461]
- Updated dependencies [d1e0186]
- Updated dependencies [ae8de0e]
- Updated dependencies [641ccbf]
- Updated dependencies [8c3e696]
- Updated dependencies [307f8fd]
- Updated dependencies [0a1f556]
- Updated dependencies [b687931]
- Updated dependencies
- Updated dependencies [1dd09de]
- Updated dependencies [a58c756]
- Updated dependencies [11dd14d]
  - @minpeter/pss-runtime@0.1.0

## 0.0.11-next.5

### Patch Changes

- 617b9f9: Refresh dependencies across the v0.1 workspace, including AI SDK 7 latest.
- Updated dependencies [617b9f9]
- Updated dependencies [7346750]
- Updated dependencies [11dd14d]
  - @minpeter/pss-runtime@0.1.0-next.24

## 0.0.11-next.4

### Patch Changes

- bf07086: Add `help`/`--help`/`-h` to the `pss` CLI and make unknown commands print usage and exit with code 1 instead of throwing.
- 4c50311: Add local thread compaction configuration and inspection support to the coding
  agent CLI.

  The TUI now shows the active thread key and auto-compaction policy, accepts
  `PSS_THREAD_*` storage settings with legacy `PSS_SESSION_*` aliases, and can
  enable runtime auto-compaction through `PSS_AUTO_COMPACTION_MIN_MESSAGES` plus
  `PSS_AUTO_COMPACTION_RETAIN_MESSAGES`. The CLI also adds `pss inspect-thread`
  for checking the configured local thread file without starting the TUI. The
  coding agent now uses the runtime Node platform host and runtime-owned file
  thread inspection helper for local thread storage.

- Updated dependencies [836a1c4]
- Updated dependencies [fedd6be]
  - @minpeter/pss-runtime@0.1.0-next.23

## 0.0.11-next.3

### Patch Changes

- Harden Cloudflare Durable Object storage for long-running agent threads and
  rename the runtime domain from sessions to threads. Runtime storage now rejects
  oversized single-row payloads before Durable Object writes, stores tool
  checkpoints as bounded thread references instead of full history snapshots, and
  uses a SQLite row queue for scheduled Cloudflare work.

  The public app-facing API now uses `agent.thread(...)`, `ThreadInput`, and
  ThreadStore names. Deprecated Session aliases remain as explicit compatibility
  adapters, while the coding-agent local thread store imports have moved to the
  new thread-store subpaths.

- Updated dependencies
  - @minpeter/pss-runtime@0.1.0-next.11

## 0.0.11-next.2

### Patch Changes

- 1dd09de: Replace the public `agent.session(key)` entrypoint with `agent.thread(key)`.
  Threads are the app-facing conversation unit; runtime session state remains an
  internal storage concern behind the thread handle. `agent.thread({ key, scope })`
  now provides an optional scoped address for multi-user integrations while
  preserving opaque session storage under the host boundary.
- Updated dependencies [4a2ab2b]
- Updated dependencies [1dd09de]
  - @minpeter/pss-runtime@0.1.0-next.9

## 0.0.11-next.1

### Patch Changes

- Sync dependency updates from main into the v0.1 prerelease line.
- Updated dependencies
  - @minpeter/pss-runtime@0.1.0-next.6

## 0.0.11-next.0

### Patch Changes

- e8bd679: Remove the built-in web tools from the coding-agent package and TUI. Callers can still pass their own tools through `@minpeter/pss-runtime`.
- Updated dependencies [0ffe9e7]
- Updated dependencies [3761c93]
  - @minpeter/pss-runtime@0.1.0-next.0

## 0.0.10

### Patch Changes

- 92af1da: Update the coding-agent TUI dependency range to pick up the latest `@earendil-works/pi-tui` release.
- Updated dependencies [5fc427d]
  - @minpeter/pss-runtime@0.0.10

## 0.0.9

### Patch Changes

- 20103d2: Make the coding-agent TUI subpath import-safe, correct multimodal docs, and remove redundant runtime type exports.
- Updated dependencies [20103d2]
  - @minpeter/pss-runtime@0.0.9

## 0.0.8

### Patch Changes

- c991a6a: Replace the public current-turn input API with `session.steer(input)` and keep
  `session.send(input)` as the new-turn queue. Active TUI submissions now steer the
  current run through the session API.
- Updated dependencies [c991a6a]
  - @minpeter/pss-runtime@0.0.8

## 0.0.7

### Patch Changes

- Updated dependencies [c71ea7d]
  - @minpeter/pss-runtime@0.0.7

## 0.0.6

### Patch Changes

- Updated dependencies [37a14b9]
- Updated dependencies [37a14b9]
- Updated dependencies [1b43c77]
  - @minpeter/pss-runtime@0.0.6

## 0.0.5

### Patch Changes

- fbe0448: Make agent sessions runtime-owned and durable through an opaque session store boundary, including memory/file stores and coding-agent TUI file-backed sessions.
- Updated dependencies [fbe0448]
  - @minpeter/pss-runtime@0.0.5

## 0.0.4

### Patch Changes

- Updated dependencies [23cce55]
  - @minpeter/pss-runtime@0.0.4

## 0.0.3

### Patch Changes

- Updated dependencies [c5b7c8b]
  - @minpeter/pss-runtime@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [f503ccd]
  - @minpeter/pss-runtime@0.0.2

## 0.0.1

### Patch Changes

- 990086e: Add the publishable `pss` CLI entrypoint for global installs and package runners.
- 8f03383: Publish the initial pss-next runtime and coding-agent packages from the new Turborepo workspace.
- Updated dependencies [8f03383]
  - @minpeter/pss-runtime@0.0.1
