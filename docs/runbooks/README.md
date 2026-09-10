# Operational runbooks

Repository-local runbooks for triaging automated checks and running the
mission's local validation flows. Every procedure here is executable from a
clean checkout with the standard toolchain (Node 24, pnpm 11.9.0); none of them
publish, deploy, or call an external production service.

## Runbooks

- [CI failure triage](ci-failure-triage.md) — diagnose a failed `ci.yml` fast
  gate and map each red step back to the root script it runs.
- [Release procedure](release-procedure.md) — how the `release.yml` versioning
  and publishing job is driven, and what to check before it runs.
- [Extended verification](extended-verification.md) — trigger and read the
  scheduled and manual suites in `extended-verification.yml`.
- [Worker health and operational checks](worker-health.md) — run the local
  Worker on `127.0.0.1:8792` and probe its health surface with scripted
  fixtures.
- [Worker privacy, retention, and masking](worker-privacy-retention.md) —
  what the Worker transport collects and persists, the exact dry-run preview
  masking boundary, and the retention guarantees it does and does not make.
- [Security-scan failure triage](security-scan-failure-triage.md) — respond to
  a failed secret or static-analysis scan without touching external services.

## Scope and boundaries

These runbooks describe only what a contributor or agent can reproduce locally
or read from committed workflow files. Externally managed controls (branch
protection, native secret scanning, hosted analytics, hosted alerting, and
production deployment or health monitoring of the Worker) are deferred and
external; they cannot be verified from repository files and are documented, not
claimed, here. The authoritative list is
[../deferred-controls.md](../deferred-controls.md), which maps each deferred
control to its repo-local substitute.
