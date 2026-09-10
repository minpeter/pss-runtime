# examples

Six private runtime demos: `background-subagent`, `basic`, `evals`, `hooks`,
`local-file-agent`, and `sync-subagent`. They are workspace packages, so a
broken example fails root `pnpm test` and CI.

## Conventions

- An example wires providers and hosts in `src/setup.ts` and drives its CLI
  loop from `src/index.ts`.
- Fixtures are package-local and never shared between examples.
- `evals` runs on `node --test`, NOT Vitest.
- Structural drift (a missing or renamed example) fails the root invariant
  tests under `scripts/`.
