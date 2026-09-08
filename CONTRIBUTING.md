# Contributing

## QA discipline

`pnpm test`, `pnpm typecheck`, and `pnpm build` being green is not QA. They prove
the unit-level contract holds, not that the user-facing behavior works. Drive the
real surface and record what you observed.

The core published packages have absolute coverage floors. Run `pnpm coverage`
to test `packages/runtime/src` and `apps/coding-agent/src`, print a terminal
report, enforce separate package baselines as well as the combined baseline, and
write machine-readable results to `coverage/core/coverage-summary.json`. JavaScript
and TypeScript test files, files named `test-support.ts` or `test-fixtures.ts`, and
`*.test-support.ts` modules are excluded; public `testing` APIs remain measured.
Examples, extensions, and experimental workspaces stay outside this focused gate.

Scope the QA to what you touched:

| Change area | Required real-surface QA |
| --- | --- |
| `apps/coding-agent/src/tui/**` | Render the TUI through the xterm.js harness: `node script/qa/web-terminal-visual-qa.mjs --title "<surface>" --command "<cmd>" --input "<keys>" --evidence-dir <dir>` |
| `apps/coding-agent/src/cli.ts`, `exec-cli.ts` | Run the built CLI (`node apps/coding-agent/bin/pss.js ...`) and capture stdout plus the exit status |
| `apps/coding-agent/src/workspace-tools/**` | Exercise the tool through a real agent turn, not just its unit test |
| `packages/runtime/**` | Scoped tests plus one execution of an affected runnable entry point |

Never use `tmux capture-pane` for terminal color, layout, or CJK evidence: it
degrades truecolor and wide-glyph width. Use the xterm.js harness instead.

The documented TUI fixture drives the coding-agent's assistant renderer
preview through the harness, proving the documented state stays reachable
without any new service:
`node script/qa/web-terminal-visual-qa.mjs --title "assistant renderer preview" --command "pnpm -C apps/coding-agent preview:assistant" --input "" --evidence-dir .omo/evidence/tui-visual-qa`.

The documented state is the assistant renderer preview (`preview:assistant`):
a composed assistant message carrying an inline LaTeX formula image and a
Mermaid diagram, rendered once per theme. The harness needs no credential,
model provider, or network access, and it opens no listening port that
outlives the run — its page server binds an ephemeral loopback port and is
closed before exit, which the `teardown.json` receipt in the evidence
directory records. Pair the run with a before/after `ss -tln` diff when
port evidence is needed.

## Evidence: record it under `.omo/evidence/` or it did not happen

Write every QA artifact to `.omo/evidence/<YYYYMMDD>-<short-slug>/`, one folder
per change. For every change record:

- **What was observed** — the before/after or new behavior, plus the artifact
  path for the exact captured output.
- **Why it is enough** — how the evidence covers the intended behavior and what
  regression risk remains.

**No evidence means no commit and no push.**

Evidence is a local artifact. `.omo/` is ignored except `.omo/plans/`, so
receipts stay on your machine while the PR body carries the verification
summary. Do not commit evidence directories, screenshots, or session state.

Evidence, logs, commit messages, and PR bodies must not contain tokens,
credentials, auth headers, cookies, or raw environment dumps.

## Failing-first proof

Every behavior change needs a proof that failed before the production change,
through the cheapest faithful channel: a unit test where a seam exists, an
integration test where the behavior lives in wiring, or the real-surface
scenario captured failing when no seam exists.

A test that cannot fail for the regression it names is not evidence. Mock-call
assertions, pinned constants, and expected values re-derived from the output
under test all pass regardless of the bug. Prefer a real-surface proof with no
new test over a tautological one.

For regression coverage of already-correct behavior there is no natural RED.
Substitute a mutation proof: temporarily break the seam, capture the assertion
failing, then revert the mutation. Never commit the mutation.

## Cleanup

QA spawns processes, browsers, ports, and temp directories. Tear down everything
you started and verify it: `kill` the pid and confirm `kill -0` fails, close
browser contexts, remove the `mktemp` paths. Leftover QA state means the change
is not done.

## Commits and PRs

- One atomic commit per verified increment; each commit builds and tests green on
  its own. No WIP commits on a branch you intend to merge.
- Read `git log --oneline -20` before writing a message and match the observed
  convention. Default to Conventional Commits (`<type>(<scope>): <imperative>`).
- Push to a feature branch and open a PR. Never push directly to `main`.
- Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md): the PR
  body states what changed, how it was verified against the real surface (with
  the evidence path under `.omo/evidence/`), and any deliberate trade-off a
  reviewer would otherwise question.
- Before merge, add a `.tegami/YYYY-MM-DD-<slug>.md` release-note entry for the
  changed published package and run `pnpm check:tegami-notes`.

## Pre-commit hook

A Husky + lint-staged pre-commit hook (`.husky/pre-commit`, config in
`.lintstagedrc.json`) lints and formats only the files in the git index at
commit time. Untracked files and unstaged working-tree content are never
passed to the linter, rewritten, or re-staged. The `prepare` script in
`package.json` wires the hook up during `pnpm install`, so a fresh checkout
reproduces the behavior with no host-specific setup.

Auto-fix mode: fix-on-write. Staged files with fixable violations are
rewritten by `ultracite fix` and re-staged by lint-staged, after which the
commit proceeds; re-running the hook on the same content is a no-op. A
violation that cannot be auto-fixed aborts the commit with the offending
file and rule named, and no file outside the index is touched. Use
`git commit --no-verify` to deliberately bypass the hook.

## Fast local gates

Fast gates give commit-time and pre-push feedback without running the heavy
pipeline: they never run the full test suite, typecheck, build, coverage,
API snapshot, stress profiles, the TUI, or the Worker. Each gate has a
concrete wall-clock bound, measured on the loaded 24-CPU reference host:

| Gate | Command | Bound (loaded reference host) |
| --- | --- | --- |
| Pre-commit hook | `git commit` (runs `pnpm exec lint-staged` via `.husky/pre-commit`) | ≤ 60 s |
| All repository invariant checks | `vitest run scripts/*.test.mjs` | ≤ 120 s |
| Any single invariant check | `vitest run scripts/<name>.test.mjs` | ≤ 30 s |

Measure a gate with the timing wrapper, which kills the whole process group
on timeout so no child survives: `node scripts/time-gate.mjs --bound 60
--label pre-commit -- git commit -m "<message>"`. The wrapper exits
non-zero when the gate fails or exceeds its bound and prints one stable
`GATE <label>: elapsed=… bound=… result=…` line.

The invariant checks (`scripts/workspace-config.test.mjs` and its siblings)
are deterministic and offline: they read only committed files, perform no
network I/O, open no ports, and write nothing outside their own stdout, so
two consecutive runs on a clean tree produce identical results. The same
checks run in CI (`pnpm test` on the Node 24/26 matrix under
`PSS_TASK_VALIDATOR_NETWORK_ISOLATED=1`) with identical outcomes.

Concurrency budget on the loaded reference host: at most one devcontainer
build and two lightweight static/config validators run concurrently; no
local-quality command binds, probes, or competes for the Worker port 8792.

## Naming conventions

Each rule states its status: **enforced** rules run in `pnpm lint`
(ultracite/biome, configured in `biome.jsonc`); **advisory** rules are tree
conventions no lint rule can check. The invariant in
`scripts/naming-conventions.test.mjs` keeps this table and the toolchain
coherent: a rule documented as enforced but absent from the config, or a
configured naming rule missing from this table, fails `pnpm test` naming the
rule.

| Subject | Convention | Status | Tooling rule |
| --- | --- | --- | --- |
| Package names | `@minpeter/pss-*` scope, kebab-case segments | Advisory | — |
| Source file names | kebab-case, ASCII only | Enforced | style/useFilenamingConvention |
| Variables and parameters | camelCase | Enforced | style/useNamingConvention |
| Constants | camelCase, PascalCase, or CONSTANT_CASE at any scope | Enforced | style/useNamingConvention |
| Functions | camelCase; PascalCase for component-like factories | Enforced | style/useNamingConvention |
| Types, interfaces, classes, enums, type parameters | PascalCase | Enforced | style/useNamingConvention |
| Enum members | PascalCase | Enforced | style/useNamingConvention |
| Class members | camelCase; static readonly constants may be CONSTANT_CASE | Enforced | style/useNamingConvention |
| Object literal and type member names | camelCase for internal shapes; mirror external contracts (env keys, JSON payloads, protocol markers) | Advisory | — |

- Acronyms keep consecutive capitals (`TMPDIR`, `SSEStream`): the naming rule
  runs with `strictCase: false`.
- Leading/trailing `_` or `$` markers (e.g. `_exhaustive`, `$pss`) are allowed
  where they denote protocol or placeholder roles.
- Biome lints tracked and untracked files alike (`vcs.useIgnoreFile: false`
  with explicit generated-output excludes in `biome.jsonc`), so a scratch
  fixture named `*.scratch.ts` anywhere in the tree is linted but never
  committed: `pnpm lint` fails on a planted out-of-convention identifier,
  naming the file and the rule id, and passes again once it is removed.

## Labels

Issue and pull-request labels follow the canonical
[label taxonomy](docs/label-taxonomy.md), which defines every `type`,
`priority`, and `area` label. Add or change labels there first; creating them
on GitHub is an external step deferred to a repository maintainer.

## Security

Do not open a public issue or pull request for a suspected vulnerability.
Follow the [security policy](SECURITY.md) to report it privately.

## Never

- Suppress lint errors, type errors, or test failures.
- Delete, skip, `.only`, `.skip`, or comment out a failing test to go green.
- Claim done from inference. Only captured evidence counts.
