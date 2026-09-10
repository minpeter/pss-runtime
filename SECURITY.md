# Security Policy

This policy is repository-local. It explains what is in scope, how to report a
vulnerability privately, and what this project does and does not promise. It
names no personal contacts and stores no credentials.

## Supported scope

Security reports are accepted for the code published from this repository:

- `@minpeter/pss-runtime` — the agent runtime, threads, model loop, storage,
  and instrumentation (`packages/runtime`).
- `@minpeter/pss-coding-agent` — the `pss` TUI, the `pss exec` headless
  runner, workspace tools, and the extension host (`apps/coding-agent`).

The repository workflows under `.github/workflows/` are also in scope, because
they run with repository permissions.

Only the latest published release line of each package is supported. Older
prereleases are not patched in place; upgrade to the current release to pick up
a fix.

## Reporting a vulnerability

Report privately through GitHub's built-in private vulnerability reporting.
Open the repository's **Security** tab and choose **"Report a vulnerability"**
to open a private advisory that only the maintainers can see. Do not open a
public issue, pull request, or discussion for a suspected vulnerability.

To let a report be triaged quickly, please include:

- A minimal reproduction — the smallest steps, command, or code that triggers
  the issue.
- The affected version — the package and release (or commit) where you
  observed it.
- An impact summary — what an attacker could do, and any preconditions.

Please keep the report and its details private until a fix has shipped and the
advisory is published. Coordinated, private disclosure protects users who have
not upgraded yet.

## What this policy does not promise

This project is maintained on a best-effort basis:

- There is no bug bounty and no paid reward program.
- No response-time SLA is offered, and no fix timeline is promised.
- No externally hosted disclosure, triage, or scanning service is guaranteed;
  reporting and coordination happen only through the GitHub-native private
  advisory flow described above.

These items are deliberately out of scope for this repository-local policy.
