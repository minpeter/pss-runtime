# @minpeter/pss-coding-agent

## 0.0.11-next.0

### Patch Changes

- e8bd679: Remove the built-in web tools from the coding-agent package and TUI. Callers can still pass their own tools through `@minpeter/pss-runtime`.
- Updated dependencies [0ffe9e7]
- Updated dependencies [3761c93]
  - @minpeter/pss-runtime@0.1.0-next.0

## 0.0.10

### Patch Changes

- 92af1da: Update the coding-agent TUI dependency range to pick up the latest `@earendil-works/pi-tui` release.
- Updated dependencies [5fc427d]
  - @minpeter/pss-runtime@0.0.10

## 0.0.9

### Patch Changes

- 20103d2: Make the coding-agent TUI subpath import-safe, correct multimodal docs, and remove redundant runtime type aliases.
- Updated dependencies [20103d2]
  - @minpeter/pss-runtime@0.0.9

## 0.0.8

### Patch Changes

- c991a6a: Replace the public current-turn input API with `session.steer(input)` and keep
  `session.send(input)` as the new-turn queue. Active TUI submissions now steer the
  current run through the session API.
- Updated dependencies [c991a6a]
  - @minpeter/pss-runtime@0.0.8

## 0.0.7

### Patch Changes

- Updated dependencies [c71ea7d]
  - @minpeter/pss-runtime@0.0.7

## 0.0.6

### Patch Changes

- Updated dependencies [37a14b9]
- Updated dependencies [37a14b9]
- Updated dependencies [1b43c77]
  - @minpeter/pss-runtime@0.0.6

## 0.0.5

### Patch Changes

- fbe0448: Make agent sessions runtime-owned and durable through an opaque session store boundary, including memory/file stores and coding-agent TUI file-backed sessions.
- Updated dependencies [fbe0448]
  - @minpeter/pss-runtime@0.0.5

## 0.0.4

### Patch Changes

- Updated dependencies [23cce55]
  - @minpeter/pss-runtime@0.0.4

## 0.0.3

### Patch Changes

- Updated dependencies [c5b7c8b]
  - @minpeter/pss-runtime@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [f503ccd]
  - @minpeter/pss-runtime@0.0.2

## 0.0.1

### Patch Changes

- 990086e: Add the publishable `pss` CLI entrypoint for global installs and package runners.
- 8f03383: Publish the initial pss-next runtime and coding-agent packages from the new Turborepo workspace.
- Updated dependencies [8f03383]
  - @minpeter/pss-runtime@0.0.1
