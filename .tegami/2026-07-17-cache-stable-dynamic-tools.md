---
packages:
  npm:@minpeter/pss-runtime: minor
---

## Add cache-aware model-step preparation

Add a PSS-owned, zero-based `prepareModelStep` callback with logical indices
that survive outer-loop overflow retries and durable resume. Support AI SDK 7
`toolOrder`, fixed always-active prefixes, deterministic dynamic suffixes, and
fail-closed validation for duplicate, unknown, overlapping, and inactive named
tool selections. Snapshot configured and callback-returned tool-name arrays
through bounded own data descriptors without invoking custom iterators or index
getters.

Emit opt-in metadata-only name and semantic cache fingerprints through host
diagnostics. The diagnostic contains bounded counts, hashes, duration, an
attempt ID, and the logical step index, never raw prompts, tool inputs, tool
definitions, or thread keys. Automatic-compaction summary calls remain outside
model-step selection.

Add a source-hashed OpenAI-compatible live-provider benchmark for stable order,
active-set reduction, and an equal-byte membership swap. Seeded alternating
AB/BA trials isolate every arm with its own warmup/canary and audit response
model, output compliance, input parity, cache-read/cache-write telemetry, and
warmup prerequisites independently. Require a sanitized `finish_reason=stop`
and exact trimmed `OK` from exactly one choice, and fail closed on unsafe
token-aggregate overflow. The
checked-in result and dated benchmark README findings are authoritative only
when schema, campaign topology, and
source-hash verification pass; no raw response content, provider payload, or
credential is retained.

Keep the generic eager selector distinct from provider-native loading. Official
AI SDK OpenAI Responses and Anthropic adapters expose their own native tool
search/defer lowering, while `@ai-sdk/openai-compatible` and the eager
FreeRouter Chat Completions benchmark make no such preservation guarantee. Pi's
Kimi work is a direct-provider-only system-message compatibility mode, not a
router capability. Gate any native follow-up by adapter, provider, model, and
version; verify it with a wire canary and fall back to eager selection when the
tuple is unknown or the canary fails.
The canary must pin and inspect an explicit approval policy because the OpenAI
API and current AI SDK OpenAI adapter have different omitted-value behavior.
Treat cache-write telemetry as a separate required signal for GPT-5.6+
economics; the generic compatible adapter does not normalize that field.
