# CI failure triage

Use this runbook when CI is red. The `ci.yml` `checks` job is the source of
truth for core correctness and runs on every pull request and push to `main`.
Pull requests use its fast lane; pushes to `main` and release validation run its
full lane.

## Fast gate steps

The `checks` job runs each of these root scripts, in order. Every command below
is invoked by a step in `ci.yml`, so you can reproduce any red step locally by
running the same script:

- `pnpm install` — install from the frozen lockfile (`ci.yml` step
  `Install dependencies`).
- `pnpm audit` — dependency advisory scan (node 24 only: the `ci.yml` step is
  gated behind `if: matrix.node == '24'`).
- `pnpm boundaries` — package import-boundary check (`ci.yml` step
  `Check package boundaries`).
- `pnpm check:compatibility` — Pi compatibility manifest validation.
- `pnpm check:tegami-notes` — release-note section check.
- `pnpm lint` — Biome/Ultracite lint (`ci.yml` step `Lint`).
- `pnpm typecheck` — TypeScript project checks (`ci.yml` step `Typecheck`).
- `pnpm test` — Turbo tests plus `vitest run scripts/*.test.mjs` (`ci.yml`
  step `Test`, run with `PSS_TASK_VALIDATOR_NETWORK_ISOLATED=1`). Pull requests
  run it on Node 24; the full lane also runs it on Node 26.
- `pnpm test:cross-platform-smoke` — Node 26 pull-request compatibility smoke.
- `pnpm coverage` — core package coverage gate (full lane, Node 24 only).
- `pnpm build` — full workspace build (full lane only).
- `pnpm api:check` — runtime public API snapshot check (full lane only).
- `pnpm verify:release` — release-artifact verification (full lane only).

## Triage steps

1. Open the failed run and note which step in the `ci.yml` job `checks` is red.
2. Reproduce it locally with the matching command from the list above. Run the
   narrowest one first (for example `pnpm lint` before `pnpm test`).
3. For a `Test` failure, re-run the collected invariants directly with
   `TMPDIR="$PWD/.omo/tmp" ./node_modules/.bin/vitest run scripts/*.test.mjs`
   and read the named failing assertion.
4. Fix the underlying cause; never delete, `.skip`, or otherwise suppress a
   failing test to make the gate pass.
5. Re-run the full `pnpm test` gate locally before pushing the fix.

## Matrix and environment notes

- The fast pull-request lane runs typechecking on Node `24` and `26`, full tests
  on Node `24`, and a Node `26` compatibility smoke. A push to `main` or a
  release validation call runs the complete matrix on both Node versions.
- `Audit dependencies` runs on Node `24` only. Coverage runs on Node `24` in
  the full lane only; a red Node `26` run can never be caused by either gate.
- The `Test` step runs under `PSS_TASK_VALIDATOR_NETWORK_ISOLATED=1`, so a test
  that reaches the network locally but is skipped in isolation is a bug in the
  test, not in CI.
- Branch-protection enforcement of this gate is deferred and external; it
  cannot be verified from repository files. The follow-up boundary lives in
  the single deferred list,
  [../deferred-controls.md](../deferred-controls.md).
