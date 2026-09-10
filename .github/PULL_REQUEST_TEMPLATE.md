# Pull request

<!-- Keep this PR small and focused. Fill in every section below. -->

## Summary

<!-- What does this change do, and why? Link the issue it resolves. -->

-

## Verification

<!--
Describe how you drove the real surface, not just that unit tests pass.
Record every QA artifact under `.omo/evidence/<YYYYMMDD>-<slug>/` (gitignored)
and reference that path here. Include the failing-first proof for any behavior
change.
-->

- Commands run (e.g. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm coverage`):
- Real-surface QA performed:
- Evidence location: `.omo/evidence/<YYYYMMDD>-<slug>/`

## Trade-offs and review notes

<!-- Call out any deliberate trade-off, risk, or alternative a reviewer should weigh. -->

-

## Release note (Tegami)

Before merge, add a release-note entry at `.tegami/YYYY-MM-DD-<slug>.md` targeting
the published package whose behavior changed:

- `npm:@minpeter/pss-runtime`, or
- `npm:@minpeter/pss-coding-agent` (also for changes under `extensions/`, which ship inside its bundle).

Use `type: patch` by default (choose `minor`/`major` only when the change requires it),
give the entry body at least one `## <Title>` section, then run:

```bash
pnpm check:tegami-notes
```

The automated `Version Packages` pull request performs the release; do not do it as part of this PR.

## Checklist

- [ ] Work is on a feature branch, not the default branch.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass locally.
- [ ] QA evidence is recorded under `.omo/evidence/` and referenced above.
- [ ] A `.tegami/YYYY-MM-DD-<slug>.md` release-note entry is added and `pnpm check:tegami-notes` passes.
- [ ] No secrets, tokens, or credentials appear in the diff, logs, or evidence.
