# scripts

Repository invariant tests and release verification. These run OUTSIDE Turbo:
root `pnpm test` collects them with `vitest run scripts/*.test.mjs`.

## Conventions

- The 250 pure-LOC ceiling per script file is enforced by
  `file-size.test.mjs`; split helpers into a sibling module instead of
  growing a file past it.
- Governance invariants ship as a `<name>.mjs` helper plus a
  `<name>.test.mjs` Vitest pair, like the `governance-*` files.
- Every check is deterministic, offline, and parallel-safe: no network, no
  ports, no shared temp state; any fixture writes stay under the gitignored
  `.omo/` tree.
- Negative cases are mandatory: each invariant test also proves the mutation
  that must fail.
