# Label taxonomy

This document is the single source of truth for the issue and pull-request
labels used across this repository. Every label referenced anywhere in the
repository (issue-form `labels:` values, pull-request template labels, and
labels cited in governance or CI docs) must be defined here, and every label
name below is unique.

> Creating these labels on GitHub is an external action, out of scope for this mission, and deferred to a repository maintainer.
> This document defines labels only; it never claims any label is created, enabled, active, or deployed remotely (that stays external and deferred).

Each entry lists the label `name`, a hex `color` (`#RGB` or `#RRGGBB`), and its
purpose. A tool or contributor picks labels from this list; the taxonomy does
not, and cannot, apply them to a GitHub repository.

## Type

Classifies the kind of change or report an issue or pull request represents.

| Name | Color | Purpose |
| --- | --- | --- |
| `type: bug` | `#d73a4a` | Something is broken or behaves incorrectly. |
| `type: feature` | `#0e8a16` | A new capability or enhancement request. |
| `type: docs` | `#0075ca` | A documentation-only change. |
| `type: chore` | `#fef2c0` | Tooling, refactor, or maintenance work. |

## Priority

Signals how urgently the item should be scheduled.

| Name | Color | Purpose |
| --- | --- | --- |
| `priority: high` | `#b60205` | Urgent; blocks a release or a contributor. |
| `priority: medium` | `#fbca04` | Normal scheduling; handle in due course. |
| `priority: low` | `#c2e0c6` | Minor; no time pressure. |

## Area

Marks the part of the monorepo an item touches.

| Name | Color | Purpose |
| --- | --- | --- |
| `area: runtime` | `#5319e7` | The `packages/runtime` engine and public API. |
| `area: coding-agent` | `#1d76db` | The `apps/coding-agent` CLI, TUI, and extension host. |
| `area: worker-agent` | `#0052cc` | The `apps/worker-agent` Worker and Telegram adapter. |
| `area: extensions` | `#006b75` | The `extensions/*` packages. |
| `area: docs` | `#bfdadc` | Repository documentation and governance files. |

## Adding or changing a label

1. Edit the relevant table above; keep every name unique and every color a
   valid hex value.
2. Update any issue form or pull-request template that references the label so
   the reference resolves to an entry here.
3. A repository maintainer mirrors the change on GitHub as a separate external step (deferred, out of scope for repository tooling).
