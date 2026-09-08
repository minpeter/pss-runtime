# Extended verification

Expensive or environment-specific checks live in `extended-verification.yml`,
separate from the fast pull-request gate. The full policy is described in
[../extended-verification.md](../extended-verification.md); this runbook is the
operational how-to.

## Suites and how they trigger

- `extended-verification.yml` job `storage-stress` — the `heavy` runtime
  storage profile, scheduled weekly and selectable manually.
- `extended-verification.yml` job `cross-platform-smoke` — macOS and Windows
  smoke tests, scheduled monthly and selectable manually.
- `extended-verification.yml` job `edge-dry-run` — builds the Worker with the
  real edge bundler via `pnpm verify:edge`; runs weekly and on demand.
- `extended-verification.yml` job `secret-gate` — detects optional credentials
  and gates the live suites.
- `extended-verification.yml` job `live-provider` — a small real-provider eval;
  it runs only when the gate reports credentials are present.
- `extended-verification.yml` job `remote-edge` — the deployed-Worker probe; it
  is manual-only and credential-gated.

Trigger a suite from the Actions tab with `workflow_dispatch` and pick a suite
from the `suite` input (`all`, `storage`, `cross-platform`, `edge`,
`live-provider`, or `remote-edge`).

## Reading skips

The `secret-gate` job writes a visible summary line when an optional credential
is absent and the dependent suite is skipped. A scheduled or `all` run skips an
unavailable optional suite with a successful summary. Explicitly selecting
`live-provider` or `remote-edge` fails when its required credentials
(`AI_API_KEY`, and for the deployed probe also `WORKER_AGENT_TUI_ENDPOINT` and
`WORKER_AGENT_TUI_TOKEN`) are missing, so a requested check cannot silently
pass without running.

## Local reproduction

- You can reproduce the edge bundling locally with `pnpm verify:edge` (a
  dry-run build; it does not deploy). The command needs no credentials and
  observes zero network egress: the worker package `build` script disables
  the wrangler banner (its npm-registry update check) and wrangler metrics,
  so repeated runs produce identical output on any machine.
- You can run the heavy storage profile locally with
  `pnpm stress:runtime-storage:heavy`.
- The live-provider and deployed-Worker suites are deferred and external for
  local runs: they require credentials that are not present on a clean checkout
  and are exercised only by the credential-gated CI jobs that own them.
