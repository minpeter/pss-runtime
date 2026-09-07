# Security-scan failure triage

Use this runbook when a security scan reports a finding. All triage here is
local or read from committed files; it never touches an external service.

## Secret detection

The repository has a deterministic secret-pattern scan that runs inside the
`ci.yml` job `checks` (in the `Test` step, collected by `pnpm test`). A dedicated
gitleaks secret-scan workflow and a CodeQL static-analysis workflow are planned
for the security milestone and are deferred until then; do not assume they are
configured yet.

When a secret-pattern check fails:

1. Reproduce locally with `pnpm test` (or run the focused governance invariants
   with `TMPDIR="$PWD/.omo/tmp" ./node_modules/.bin/vitest run
   scripts/*.test.mjs`) and read the named failing assertion and file.
2. Remove the offending literal from the working tree. Never commit real
   credentials, tokens, or `.env` contents; use the documented placeholder
   secret names instead and keep real values in an untracked `.dev.vars`.
3. If a secret was already committed in history, treat it as compromised: rotate
   it out of band and follow [../../SECURITY.md](../../SECURITY.md) for private
   reporting. Rotation happens in the owning service, not from this repository.
4. Re-run `pnpm test` to confirm the scan is green before pushing.

## Static-analysis findings

For a static-analysis alert (for example from the planned CodeQL workflow):

1. Read the rule id and the flagged file/line from the run summary.
2. Reproduce the relevant local check (`pnpm lint`, `pnpm typecheck`) where the
   rule overlaps the repository's own static analysis.
3. Fix the underlying code; do not suppress the rule to make the scan pass.

## Boundaries

Native GitHub secret scanning and any hosted scanning or alerting service are
deferred and external: they cannot be configured or verified from repository
files. The repository-local substitutes are the deterministic secret-pattern
scan and the security workflows added in the security milestone.
