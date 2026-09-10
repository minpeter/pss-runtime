# Security-scan failure triage

Use this runbook when a security scan reports a finding. All triage here is
local or read from committed files; it never touches an external service.

## Workflow secret policy

The security workflows — CodeQL, gitleaks, and ZAP — reference no authored
repository or environment secrets: no `secrets.*` context appears anywhere in
those workflow files, and they never set a provider or Telegram credential
env var (`AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `WORKER_AGENT_TUI_*`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET_TOKEN`). None of the checks
these workflows run needs a credential for this repository, so a missing
credential can never silently pass or fail them.

The auto-injected `github.token` context is not an authored secret reference
and is explicitly permitted, but only as an env value consumed by a tool; it
must never be printed, echoed, or logged from a `run:` step, and it never
appears in step `with:` inputs either. Secret values exist only as env values
consumed by tools, never in step output. The invariant test
`scripts/security-workflow-secrets.test.mjs` enforces this policy over every
workflow file, and the credential-gated suites in
`extended-verification.yml` stay behind the visible `secret-gate` job
instead of touching the security workflows.

## Action pinning policy

Every external `uses:` reference in every workflow under `.github/workflows/`
is pinned to a full 40-hex commit SHA with a trailing version comment on the
same line (`actions/checkout@3d3c42e5... # v7`), so a retagged or hijacked
release tag can never change what a workflow runs. The single exemption is
local composite actions (`uses: ./...`): they are repository content reviewed
in the same change that ships them, so SHA pinning does not apply. The
invariant test `scripts/security-action-pinning.test.mjs` scans every
workflow file and fails naming the file, step, and reference for any
unpinned external reference.

## Secret detection

The repository scans for committed secrets in two layers: a deterministic
secret-pattern scan that runs inside the `ci.yml` job `checks` (in the `Test`
step, collected by `pnpm test`), and the `gitleaks.yml` workflow, which runs
the gitleaks binary over the repository checkout.

### gitleaks history scan

The `gitleaks.yml` workflow runs on push to `main`, on pull requests, on a
weekly schedule, and on manual dispatch. Its job `scan` holds only
`contents: read` and no other scope.

Scan scope: full git history. The checkout step fetches every commit
(`fetch-depth: 0`) and the step `Scan full git history (gitleaks git)` runs
`gitleaks git` with no `--log-opts` restriction, so every commit reachable
from the checked-out ref is scanned on every trigger, not just the event's
commit range. Rationale: a secret that was committed and later edited out of
the working tree still leaks until it is rotated, so a working-tree-only
scan would report a clean tree while history still exposes the value. The
workflow file records the same scope and rationale in its header comment.

Output and failure mode: gitleaks prints each finding redacted in the step
log and exits non-zero, which fails the step, the job, and the run. The scan
step carries no `continue-on-error`, and the workflow never suppresses
findings beyond the committed allowlist in `.gitleaks.toml`.

Local availability: the gitleaks binary is not installed on the reference
development host, and a local run is not required. When the binary is
absent, local validation is the deterministic secret-pattern scan in
`pnpm test` plus the static workflow/config invariants in
`scripts/security-gitleaks.test.mjs`; the CI workflow run is the gitleaks
execution path. Never claim a local gitleaks result without actually running
the binary.

Triage when the scan fails:

1. Open the failed run and read the `Scan full git history (gitleaks git)`
   step log; each finding names the rule, file, and commit with the secret
   value redacted.
2. True positive: treat the secret as compromised. Rotate it out of band in
   the owning service — rotation never happens from this repository — then
   follow [../../SECURITY.md](../../SECURITY.md) for private reporting if the
   exposure came from a contributor report.
3. False positive: add a specific, anchored path or a narrow placeholder
   regex to the allowlist in `.gitleaks.toml`, matching the existing entries
   for the example env files. Never add a catch-all path or regex; the
   invariant test rejects broad suppressions.
4. Re-run the workflow (or push the fix) and confirm the run goes green.

When the deterministic secret-pattern check fails:

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

The `codeql.yml` workflow runs CodeQL over the JavaScript/TypeScript language
on push to `main`, on pull requests, on a weekly schedule, and on manual
dispatch.

For a static-analysis alert:

1. Read the rule id and the flagged file/line from the run summary.
2. Reproduce the relevant local check (`pnpm lint`, `pnpm typecheck`) where the
   rule overlaps the repository's own static analysis.
3. Fix the underlying code; do not suppress the rule to make the scan pass.

### CodeQL upload-failure mode and recovery

The `codeql.yml` job `analyze` holds only `contents: read` plus the minimal
`security-events: write` scope, which the `Perform CodeQL analysis` step uses
to upload SARIF results to code scanning.

Failure mode (visible, never silent): when the upload fails — for example
during a code-scanning outage — the step exits non-zero, the job fails, and
the run is red on the pull request, commit, or scheduled run. The workflow
carries no `continue-on-error` and never disables the upload, so a failed
upload cannot pass as green.

Recovery:

1. Open the failed run and read the `Perform CodeQL analysis` step log to
   confirm the failure is in the upload, not the analysis itself.
2. Re-run the failed job from the run page; a transient code-scanning outage
   usually clears on retry.
3. If the failure persists, confirm the `analyze` job still declares
   `security-events: write` and that no repository setting outside this
   repository revoked the permission; hosted code-scanning availability is
   external and cannot be verified from repository files.
4. Never silence the failure with `continue-on-error` or by disabling the
   upload; a muted security signal is worse than a red run.

## Dynamic baseline scan (OWASP ZAP)

The `zap.yml` workflow runs an OWASP ZAP baseline scan through the job
`baseline`. Trigger: manual `workflow_dispatch` only — never push, pull
request, or schedule — with a required `target-url` input whose default is
EMPTY (never loopback, never any host). Dispatching with an empty input runs
the `Skip scan (no target declared)` step, which posts a visible skip notice
to the step log and the run summary and exits green without scanning.

Expected output when a target is supplied: the `zap.yml` step
`ZAP baseline scan` runs the SHA-pinned baseline action under
`timeout-minutes: 20` with the spider bounded to five minutes, constrained to
the declared target's host. Findings print in the step log and the action
writes its report files as workflow artifacts; issue writing is disabled and
the job holds `contents: read` with no write scope, so the scan cannot
modify the repository. A baseline finding warns in the log; the run stays
green unless the action itself errors, so a green run with findings still
requires reading the step log.

Triage when the scan reports findings:

1. Open the run and read the `ZAP baseline scan` step log; each finding
   names the risk level, the URL on the scanned target, and the evidence.
2. True positive: fix the application at the flagged URL; do not tune the
   scan to make the finding disappear.
3. False positive: record the rationale in the pull request that ships the
   fix or the suppression decision; the repository carries no ZAP rule
   suppressions by default.
4. Re-run the workflow from the dispatch page with the same `target-url` and
   confirm the finding clears.

When the tool is unavailable: the scan target is always an operator-supplied
deployment and the hosted baseline action is an external service; neither is
verified or guaranteed from repository files. If the action or the target
host is unreachable, the step fails visibly (no `continue-on-error`), so a
muted scan can never pass as green. Because the workflow is manual-only, its
absence never blocks the fast `ci.yml` gate; ordinary pull request checks
never invoke ZAP.

## Analysis report hygiene

Every analysis tool (Knip, jscpd, workspace drift, bundle budget, test timing,
flaky detection) writes its report to a gitignored path — under `report/` (or
the `.omo/` / `.senpi/` agent workspaces) — and never to a tracked file. After
any analysis run, `git status` must stay free of report files; if one appears,
the `.gitignore` coverage regressed and must be restored before committing.

Each tool caps its report at a documented maximum entry count, declared in the
canonical registry `scripts/report-paths.mjs` and enforced by
`scripts/report-hygiene.test.mjs`. A noisy run truncates at the cap and adds a
`note` field naming it, so reports stay reviewable and bounded in size:

| Tool | Report producer | Cap (entries) |
| ---- | --------------- | ------------- |
| Knip unused code | `check:unused:report` | 500 |
| jscpd duplicates | `check:duplicates:report` | 500 |
| Workspace drift | `check:workspace-drift` | 200 |
| Bundle budget | `check:bundle-size` | 100 |
| Test timing | `test:timing` | 10000 |
| Flaky detection | scheduled workflow | 1000 |

Gate-mode reports (Knip, jscpd, drift, bundle budget) are local-only: CI runs
the gate, and the report is regenerated on demand. CI-only reports (test
timing, flaky detection) are uploaded as workflow artifacts with an explicit,
bounded `retention-days` and are never committed.

## Boundaries

Native GitHub secret scanning and any hosted scanning or alerting service are
deferred and external: they cannot be configured or verified from repository
files. The repository-local substitutes are the deterministic secret-pattern
scan and the security workflows added in the security milestone; the committed
CodeQL and gitleaks workflows activate in CI on the next push that carries
them, so no CI result is observable from the local tree. The follow-up
boundaries for these deferred items live in the single deferred list,
[../deferred-controls.md](../deferred-controls.md).
