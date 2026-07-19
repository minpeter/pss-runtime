---
packages:
  npm:@minpeter/pss-coding-agent:
    replay:
      - exit-prerelease(npm:@minpeter/pss-coding-agent)
---

## Render assistant output with pi-tui Markdown and centralized themes

Upgrade `@earendil-works/pi-tui` from 0.80.7 to 0.80.10. The new release
expands visible tabs to the layout's fixed width during output normalization,
so terminal tab stops can no longer wrap a logical line mid-render.

The TUI now renders `assistant-output` through pi-tui's `Markdown` component
instead of a single green line: headings, bold/italic, inline code, code
blocks, lists, quotes, and links are styled through a `MarkdownTheme` with the
assistant green applied as the default body style. `createTuiRunner()` accepts
an optional `addMarkdown` sink and routes assistant output there when present,
falling back to the plain formatted line otherwise, so the runner stays
decoupled from pi-tui components.

Scattered hand-rolled ANSI codes in `tui-runner.ts` and `tui-tool-printer.ts`
move into a shared `tui-theme.ts` module (label color functions plus the
markdown theme), preserving the exact SGR sequences the TUI emitted before.
`truncateDetail()` now uses pi-tui's width-aware `truncateToWidth`, so
double-column CJK/emoji text can no longer overflow the truncation budget the
way character-count slicing did.
