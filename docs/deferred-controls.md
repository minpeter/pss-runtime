# Deferred external-only controls

This document is the single authoritative list of readiness controls that are
**deferred** because they are external-only: they depend on GitHub repository
settings or hosted third-party services that this mission never configures.
Every item below carries a deferred/external-only marker and states that it
cannot be verified from repository files or local commands. Other surfaces
(the README, the runbook index, governance docs) link here instead of
restating the list.

No repository file may claim a control listed here is configured, enabled,
active, deployed, rolled out, or verified. The governance invariant suite
(`scripts/governance-deferred.test.mjs`, collected by `pnpm test`) scans the
documentation and workflows and fails on any completion-style claim that does
not carry explicit deferral wording.

## How to read an entry

Each entry names the external-only control, its status, why local
verification is impossible, the repository-local substitute that IS provided
and validated here, and a follow-up boundary that points back to this
document as the single deferred list. Cited artifacts are
repository-root-relative paths in backticks. Every cited artifact exists in
the repository today, and removing a required item, flipping a marker to
done, dropping a follow-up boundary, or citing a substitute that does not
exist fails the invariant suite.

## The deferred controls

### 1. Branch-protection enforcement

- Status: deferred (external-only)
- Cannot be verified from repository files or local commands:
  branch-protection rules live in GitHub repository settings, which this
  mission never touches.
- Repo-local substitute: advisory ownership via `.github/CODEOWNERS`, which
  records ownership without any enforcement claim.
- Follow-up boundary: completing this item takes a GitHub repository-settings
  change that stays deferred and external; track it in
  `docs/deferred-controls.md`, the single deferred list, never from a
  repository-local check.

### 2. Native GitHub secret-scanning settings

- Status: deferred (external-only)
- Cannot be verified from repository files or local commands: the native
  scanning toggles live in GitHub repository settings, outside any committed
  file.
- Repo-local substitutes: the deterministic secret-pattern scan collected by
  `pnpm test` with triage steps in
  `docs/runbooks/security-scan-failure-triage.md`, plus the CodeQL
  static-analysis workflow at `.github/workflows/codeql.yml` and the gitleaks
  full-history workflow at `.github/workflows/gitleaks.yml`.
- Follow-up boundary: the native scanning toggles are a GitHub settings
  action, and the committed CodeQL and gitleaks workflows stay pending until
  the next push activates them in CI — no CI run is observable from the local
  tree, so both stay external and deferred until then; track completion in
  `docs/deferred-controls.md`, the single deferred list.

### 3. Product analytics

- Status: deferred (external-only)
- Cannot be verified from repository files or local commands: no hosted
  analytics backend is wired to this repository, and product analytics would
  require an external service account.
- Repo-local substitute: the runtime and Worker OpenTelemetry instrumentation
  contract documented in `docs/worker-agent.md`.
- Follow-up boundary: wiring a hosted analytics backend takes an external
  service account this repository never configures; the item stays deferred
  and is tracked in `docs/deferred-controls.md`, the single deferred list.

### 4. Hosted error tracking

- Status: deferred (external-only)
- Cannot be verified from repository files or local commands: hosted error
  tracking (Sentry, Bugsnag, Rollbar) would require an external service
  account this mission never configures.
- Repo-local substitute: documented runtime instrumentation, via
  `openTelemetry()` in `packages/runtime/README.md` and the Worker wiring in
  `docs/worker-agent.md`.
- Follow-up boundary: connecting a hosted error-tracking service takes an
  external account and stays deferred; track it in
  `docs/deferred-controls.md`, the single deferred list.

### 5. Hosted alerting

- Status: deferred (external-only)
- Cannot be verified from repository files or local commands: hosted alerting
  (PagerDuty, OpsGenie) would require an external paging service, outside
  repository files.
- Repo-local substitute: the Worker's shipped `/healthz` route (bounded,
  secret-free health JSON on `127.0.0.1:8792`) and its metrics spans, both
  documented in `docs/runbooks/worker-health.md`.
- Follow-up boundary: wiring a hosted paging service is an external action
  that stays deferred; track it in `docs/deferred-controls.md`, the single
  deferred list.

### 6. Progressive rollout

- Status: deferred (external-only)
- Cannot be verified from repository files or local commands: progressive
  rollout needs a hosted deployment platform's traffic controls, which no
  committed file can show.
- Repo-local substitute: the single-path release procedure in
  `docs/runbooks/release-procedure.md`, driven by
  `.github/workflows/release.yml`.
- Follow-up boundary: traffic-shift controls on a hosted deployment platform
  are external and stay deferred; track the item in
  `docs/deferred-controls.md`, the single deferred list.

### 7. Automated rollback

- Status: deferred (external-only)
- Cannot be verified from repository files or local commands: automated
  rollback needs hosted deployment state and triggers that no repository file
  contains.
- Repo-local substitute: the repository-local release path documented in
  `docs/runbooks/release-procedure.md`.
- Follow-up boundary: hosted rollback triggers and deployment state stay
  external and deferred; track the item in `docs/deferred-controls.md`, the
  single deferred list.

### 8. Remote GitHub label creation

- Status: deferred (external-only)
- Cannot be verified from repository files or local commands: creating labels
  on GitHub is an external settings action this mission never performs.
- Repo-local substitute: the canonical label definitions in
  `docs/label-taxonomy.md`.
- Follow-up boundary: mirroring the labels on GitHub is an external settings
  action that stays deferred; track it in `docs/deferred-controls.md`, the
  single deferred list.

### 9. CODEOWNERS enforcement

- Status: deferred (external-only)
- Cannot be verified from repository files or local commands: enforcing
  owners through required reviewers lives in GitHub branch settings, outside
  the repository.
- Repo-local substitute: the advisory `.github/CODEOWNERS` ownership map.
- Follow-up boundary: requiring owner review is a GitHub branch-settings
  action that stays deferred and external; track it in
  `docs/deferred-controls.md`, the single deferred list.

### 10. Dependabot run activation

- Status: deferred (external-only)
- Cannot be verified from repository files or local commands: dependabot run
  activation happens in GitHub repository settings, and a committed config
  cannot prove a run.
- Repo-local substitute: the committed, grouped update configuration
  `.github/dependabot.yml`.
- Follow-up boundary: turning on dependabot runs is a GitHub settings action
  that stays deferred and external; track it in
  `docs/deferred-controls.md`, the single deferred list.

### 11. Production deployment and health monitoring of the Worker

- Status: deferred (external-only)
- Cannot be verified from repository files or local commands: production
  deployment and health monitoring of the Worker happen on hosted Cloudflare
  infrastructure, never in this repository.
- Repo-local substitute: the local validation flow on `127.0.0.1:8792` in
  `docs/runbooks/worker-health.md`, built on the shipped `/healthz` route and
  the Worker's own metrics spans.
- Follow-up boundary: deploying and monitoring the production Worker stays
  deferred and external on hosted Cloudflare infrastructure; track the item
  in `docs/deferred-controls.md`, the single deferred list.
