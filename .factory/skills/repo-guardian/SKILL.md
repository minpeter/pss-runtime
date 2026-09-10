---
name: repo-guardian
description: Run the repository's local quality gate and governance invariants before handing off a change, using only offline, non-mutating commands.
---

# Repo Guardian

Use this skill when preparing a change in this monorepo for review. It keeps the
working tree honest with the same deterministic checks the CI fast gate runs,
all offline and side-effect-free.

## Local quality gate

Run these root scripts from the repository root, in order, and resolve any
failure before continuing:

- `pnpm lint` — Biome/Ultracite static analysis.
- `pnpm typecheck` — TypeScript project check across the workspace.
- `pnpm test` — Turbo package tests plus the repository invariants.
- `pnpm build` — Turbo build of every workspace package.

## Governance invariants

Deterministic repository invariants live under `scripts/` as `*.test.mjs` files
collected by `pnpm test`. When you add or change a governed artifact, add or
update its invariant in the same style and keep each script within the
repository's pure-LOC ceiling; split modules rather than growing one file. The
governed surfaces include:

- Contribution rules: `CONTRIBUTING.md`.
- Operational runbooks index: `docs/runbooks/README.md`.
- Label taxonomy: `docs/label-taxonomy.md`.
- Security reporting policy: `SECURITY.md`.

## Boundaries

Deployment, publishing, and pushing to `main` are out of scope for this skill
and are never performed from a local checkout. This skill only reads files and
runs the offline checks above.
