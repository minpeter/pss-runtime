---
packages:
  npm:@minpeter/pss-runtime: minor
---

## Add cache-aware model-step preparation

Add a PSS-owned, zero-based `prepareModelStep` callback with logical indices
that survive outer-loop overflow retries and durable resume. Support AI SDK 7
`toolOrder`, fixed always-active prefixes, deterministic dynamic suffixes, and
fail-closed validation for duplicate, unknown, overlapping, and inactive named
tool selections.

Emit opt-in metadata-only tool-name cache fingerprints through host diagnostics.
The diagnostic contains counts, hashes, and the logical step index, never raw
prompts, tool inputs, tool definitions, or thread keys. Automatic-compaction
summary calls remain outside model-step selection.
