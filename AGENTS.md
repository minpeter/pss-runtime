# Repository Instructions

## Development

- Use `pnpm` for workspace commands.

## Pull Requests and Releases

- Include a Changeset only for changes that should produce a package release or
  changelog entry, such as user-visible runtime behavior, package-facing APIs,
  dependency changes that affect consumers, or release process changes.
- Do not add a Changeset for repository-only maintenance such as agent
  instructions, local ignore rules, internal notes, or other changes that should
  not release `@minpeter/pss-runtime` or `@minpeter/pss-coding-agent`.
- When a Changeset is needed and the user does not explicitly request a `major`,
  `minor`, or `patch` release level, create a `patch` Changeset by default.
- Use `pnpm changeset` for interactive Changeset creation when practical;
  otherwise add a valid markdown file under `.changeset/`.
