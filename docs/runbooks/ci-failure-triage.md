# CI failure triage

Use this runbook when the pull-request CI check is red. The pull-request gate
is the `ci.yml` job `checks`; it is the source of truth for core correctness
and runs on every pull request and push to `main`.

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
  step `Test`, run with `PSS_TASK_VALIDATOR_NETWORK_ISOLATED=1`).
- `pnpm coverage` — core package coverage gate (node 24 only: the `ci.yml`
  step is gated behind `if: matrix.node == '24'`).
- `pnpm build` — full workspace build (`ci.yml` step `Build`).
- `pnpm api:check` — runtime public API snapshot check.
- `pnpm verify:release` — release-artifact verification.

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

- The gate runs on the Node `24` and `26` matrix; a failure on only one Node
  version usually points at a version-specific API or type difference.
- The `Audit dependencies` and `Check core package coverage` steps run only on
  the Node `24` matrix leg (`if: matrix.node == '24'`); a red `26` run can
  never be caused by those two steps, and an advisory or coverage regression
  surfaces on the `24` leg only.
- The `Test` step runs under `PSS_TASK_VALIDATOR_NETWORK_ISOLATED=1`, so a test
  that reaches the network locally but is skipped in isolation is a bug in the
  test, not in CI.
- Branch-protection enforcement of this gate is deferred and external; it
  cannot be verified from repository files.
