---
name: edge-contract-check
description: Verify the Worker edge bundle and the runtime public API contract locally without contacting any external service.
---

# Edge Contract Check

Use this skill after changing the Worker application or the runtime public
surface, to confirm the edge bundle and API contract still build and match the
committed snapshot. Everything here is offline.

## Build and contract checks

Run these root scripts from the repository root:

- `pnpm verify:edge` — bundles the Worker application (`apps/worker-agent/`) as a
  dry run; it never contacts a remote environment.
- `pnpm api:check` — confirms the runtime public API matches its committed
  snapshot.
- `pnpm build` — builds the full workspace so downstream consumers stay valid.
- `pnpm coverage` — runs the coverage gate.

## Reference docs

- Worker transport and contract notes: `docs/worker-agent.md`.
- Local Worker health and validation boundary: `docs/runbooks/worker-health.md`.

## Boundaries

This skill performs read-only, offline verification only. It does not contact
live providers and does not mutate any external environment.
