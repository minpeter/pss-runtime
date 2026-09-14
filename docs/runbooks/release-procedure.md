# Release procedure

Releasing is automated by `release.yml`, which runs on every push to `main`.
This runbook explains how that workflow is driven and what a
contributor prepares locally; it never runs a publish or deploy from a laptop.

## What the release job does

The `release.yml` workflow validates and publishes one exact commit SHA:

- The `validate` job calls the repository's complete `ci.yml` workflow at the
  release commit. Both Node matrix legs and every required validation step must
  pass.
- The separate `publish` job needs `validate`, has a 15-minute timeout, and is
  the only job granted `contents: write`, `pull-requests: write`, and
  `id-token: write`.
- `publish` runs `pnpm tegami ci`, which
  either opens/updates the automated "Version Packages" pull request or, when
  that pull request is merged, publishes the changed packages to the npm
  registry.

Release runs share one non-canceling concurrency group. A newer push waits for
an in-flight version or publish operation instead of racing it or canceling it
mid-publication.

Publishing authenticates through npm Trusted Publishing (GitHub OIDC). No
publish token or credential is stored in the repository, and none should ever
be added.

## Contributor checklist (local)

1. Add a `.tegami/YYYY-MM-DD-<slug>.md` release-note entry targeting the changed
   published package (`npm:@minpeter/pss-runtime` or
   `npm:@minpeter/pss-coding-agent`) with a `patch` type unless a different
   level is requested.
2. Give the entry body at least one `## <Title>` section.
3. Run `pnpm check:tegami-notes` and `pnpm tegami` to confirm the note parses.
4. Run the local gate (`pnpm lint`, `pnpm typecheck`, `pnpm test`,
   `pnpm build`, `pnpm verify:release`) before opening the pull request.

## What not to do locally

- Do not publish packages or deploy the Worker from a local machine; the
  `release.yml` job owns those actions.
- Do not merge the automated "Version Packages" pull request unless a release
  was explicitly requested — merging it publishes to the npm registry.
- Progressive rollout and automated rollback are deferred and external; they
  are not part of this repository-local procedure. Their follow-up boundaries
  live in the single deferred list,
  [../deferred-controls.md](../deferred-controls.md).
