---
packages:
  "npm:@minpeter/pss-runtime": minor
---

## Add cache-aware model-step preparation

Add a PSS-owned, zero-based `prepareModelStep` callback with a logical index
that is reused across overflow and pre-commit retries, then advances from
committed history after durable resume. Support AI SDK 7 `toolOrder`, fixed
`alwaysActiveTools` prefixes, and deterministic dynamic suffixes. Preserve
factory-plugin middleware when the callback overrides the model, and fail
closed on duplicate, unknown, overlapping, or inactive tool selections,
malformed model overrides, and invalid tool-choice values. Snapshot configured
and callback-returned tool-name arrays through bounded own data descriptors
without invoking custom iterators or index getters.

Emit opt-in metadata-only name and semantic cache fingerprints through host
diagnostics. The diagnostic contains bounded counts, hashes, duration, an
attempt ID, and the logical step index, never raw prompts, tool inputs, tool
definitions, or thread keys. Automatic-compaction summary calls remain outside
model-step selection.

Add a source-hashed OpenAI-compatible live-provider benchmark for stable order,
active-set reduction, and an equal-byte membership swap. Seeded alternating
AB/BA trials derive namespaces and inert canaries from first/second execution
slots, not variant identity, so control and changed arms are counterbalanced
across cache-affinity slots. Audit response model, output compliance, input
parity, cache-read/cache-write telemetry, sanitized backend-metadata drift, and
warmup prerequisites independently. Require a sanitized `finish_reason=stop`
and exact trimmed `OK` from exactly one choice, fail closed on unsafe
token-aggregate overflow, and bound/cancel oversized JSON responses at 1 MB for
Chat Completions and 5 MB for `/models`. Retain provider HTTP failures only as
status-derived codes so reflected
credentials cannot reach artifacts or logs. Record response-ID duplicate and
cross-request-body reuse counts.

Treat provider-reported raw cache-read tokens and cache-read/input coverage
ratio as parallel descriptive endpoints. Require all four pairs in every AB/BA
model stratum, derive ratio pair and median signs with exact `BigInt` rational
arithmetic, and make any endpoint disagreement indeterminate; opposing
directions are explicitly denominator-sensitive. Neither endpoint is a causal
saving or cost estimate, and same-set/membership conclusions remain descriptive
without exact input parity. Track separate read/write ratio-eligible counts and
coverage, require every model-level conclusion to agree before publishing a
pooled direction, and reserve input-token parity for full exact equality rather
than cancelling median-zero differences.

The evidence source manifest includes root and runtime TypeScript, build,
task-runner, and formatter configurations. An evidence campaign refuses a dirty
worktree, fixes the output path, and before authenticated provider preflight
byte- and hash-compares every current manifested source with its source-freeze
Git tree blob. It records the freeze SHA plus clean-at-start status and rechecks
HEAD around source snapshots and atomic output. Keep all-sample descriptive
views, but gate `primaryComparisons` and primary membership input parity on one
matched non-null `system_fingerprint` and `service_tier` across both arms'
warmups and measurements. Any campaign-global repeated response ID, including a
same-body replay, also excludes the affected primary pair; cross-body reuse is
audited separately. The checked-in result and dated benchmark README findings
are authoritative only when schema, campaign topology, and source-hash
verification pass; no raw response content, provider payload, or credential is
retained.

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
For Anthropic, reject a deferred tool that also carries `cache_control`, keep
the complete tools array stable across continuation, and canary the documented
server/custom search-result replay shapes before enabling native loading.
