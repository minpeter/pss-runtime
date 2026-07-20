---
packages:
  npm:@minpeter/pss-runtime:
    replay:
      - exit-prerelease(npm:@minpeter/pss-runtime)
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Structural deslop: flow-aligned layout, module splits, legacy removal

Reorganize `apps/worker-agent/src` from a flat prefix-named directory into
flow-aligned modules (`agent/`, `session/`, `session-index/`, `telegram/`,
`tui/`, `testing/`), and lift the worker tRPC surface out of `tui/` into a new
`rpc/` layer so `session/` and `tui/` no longer import each other. Channel
sink composition moves to the root `message-sinks.ts`, leaving the `agent/`
core free of channel-adapter imports.

Split the eight remaining oversized production modules (>250 pure LOC) by
responsibility — including `runtime`'s `plugin-input-hooks`, `evals/types`,
`agent/core/agent`, and `thread/handle/agent-thread`, plus coding-agent's
`tools` — and remove zero-reference legacy: one dead coding-agent module, five
dead declarations, and sixty-five exports made module-private.

No public API or behavior change: runtime root exports and the coding-agent
subpath exports are unchanged.
