# apps/coding-agent

Published as `@minpeter/pss-coding-agent` (prereleases on the `next` tag): the
`pss` CLI, the pi-tui TUI, a headless runner, and the extension host. The
former extension-api package is merged in here and shipped as the
`@minpeter/pss-coding-agent/extension` (+`/legacy`) subpath that extensions
import.

## Invariants

- After CLI router changes, run the built `bin/pss.js` after `pnpm build`
  (for example `node apps/coding-agent/bin/pss.js --help` from the repo
  root); source-only checks miss packaging drift. The closed-loop error
  probes (`pss exec` with invalid options or a misconfigured model
  environment) exit 1 with a bounded static error and never touch the
  network, a credential, or a port — see the README error contract.
- TUI changes require the web-terminal visual QA harness at
  `script/qa/web-terminal-visual-qa.mjs`; captured evidence stays out of git.
- Every workspace tool goes through `resolveWorkspacePath` and `atomicWrite`;
  file edits address lines with hashline `LINE#ID` anchors.
- Built-in extensions are thin factories on `pss.provide(...)`; latex/mermaid
  register fallback assistant renderers, and an installed same-id extension
  shadows the copy bundled into the dist build.

## Where to look

- `src/tui/agent.ts` — the largest file in the repo.
- `src/tui/app.ts` — the TUI composition root.
- `src/extensions/` — the 9 capability kinds of the authoring API.
- `src/workspace-tools/` — the file/shell tools.
