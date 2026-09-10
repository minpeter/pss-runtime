# packages/runtime

Published as `@minpeter/pss-runtime` (prereleases on the `next` tag). The
package entrypoint is a mega-barrel over the 13 area directories in `src/`
(agent, channel, contracts, evals, execution, fsm, internal, llm, otel,
platform, testing, thread, types).

## Invariants

- The public API is snapshot-tested: run `pnpm api:check` after touching any
  export, and `pnpm api:update` only when the new surface is intentional.
- Declarations forbid `export *`; extend the barrel with named exports.
- No `index.ts` inside `thread/{handle,input,runtime}` or `platform/` —
  import concrete file paths in those areas.
- Platform adapters (cf/file/memory) live in `src/platform/`; the shared
  contract suites gate any new platform.
- After execution-store changes, run the storage stress profiles selected by
  `PSS_RUNTIME_STORAGE_STRESS_PROFILE` (default/heavy/extreme/torture).

## Where to look

- `src/thread/runtime/` — the engine (queue drain, compaction, kill); its own
  AGENTS.md goes deeper.
- `src/execution/` — the durable `AgentHost` / `HostStore` / checkpoint
  contracts that platforms implement.
- `src/llm/llm.test.ts` — the largest test file in the repo.
