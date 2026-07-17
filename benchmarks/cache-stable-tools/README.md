# Cache-stable dynamic tools: live-provider benchmark

This benchmark tests a narrow provider premise behind PSS tool selection:
whether preserving an exact tool/prompt prefix correlates with
provider-reported prompt-cache reuse. It sends sequential OpenAI-compatible
chat-completion requests directly so sanitized usage telemetry remains
observable. PSS resolver and adapter wiring are tested separately; the live
script is not presented as an end-to-end runtime test.

The live runner emits an eager top-level `tools` array over raw Chat
Completions. The local wire smoke uses `@ai-sdk/openai-compatible` to reproduce
that generic eager shape. Neither path sends OpenAI Responses `tool_search`,
Anthropic `defer_loading`/`tool_reference`, OpenAI `additional_tools`, or Kimi
system-message tool declarations. A cache hit here therefore supports only the
eager exact-prefix premise; it does not show that FreeRouter preserves any
upstream native deferred-tool protocol.

## Design

The `all` scenario set runs three paired comparisons:

1. **Same set, different order.** Both arms warm with canonical order. The
   measurement preserves or reverses the same definitions.
2. **Changed active set.** Both arms warm with the full set. The measurement
   repeats it or removes a dynamic suffix while preserving the fixed prefix.
3. **Membership-only change.** The measurement repeats the full set or swaps
   one tool at the same position for a different, equal-byte definition. Tool
   count, tools-array bytes, and request-body bytes remain equal.

Equal bytes do not imply equal tokenizer output. The third scenario therefore
has a dedicated input-token parity audit, independent of cache-read reporting.
It records complete valid-input pairs, equal/control-higher/changed-higher
counts, each delta, and missing pairs. A difference is reported, not silently
normalized or treated as a benchmark failure; it limits interpretation of
absolute cache-token deltas. The checked-in verifier requires valid parity
telemetry for at least 75% of membership pairs.

Every arm has a unique fixed-length prompt namespace and a unique, equal-shape
inert canary before the benchmark tools. Its warmup and measurement alone share
those values. A measurement is eligible for cache aggregation only when its own
warmup was a recognized zero-tool-call response from the exact requested model
with exactly one choice, `finish_reason=stop`, and exact trimmed text `OK`.
The verifier checks that unchanged arms reuse both tools-array and request-body
hashes, changed arms change both hashes, and the same-set/membership swaps keep
serialized byte length equal.

Trial order is deterministic but counterbalanced. A SHA-256 bit of seed, model,
and scenario selects the first AB or BA order, then every trial alternates. With
eight trials, each model/scenario stratum has four control-first and four
changed-first assignments. Requests remain sequential to avoid benchmark-made
concurrency as a cache-affinity or latency variable.

Headline direction is order-robust, not merely pooled. Each AB/BA order must
retain at least 75% complete eligible pairs, and both order-stratum medians
must have the same nonzero sign before the result says either arm was higher.
Two zero medians report no observed median difference. Opposite signs, or a
zero/nonzero split, are reported as order-sensitive; missing stratum coverage
is indeterminate. The membership input-token parity audit uses the same rule.

## What counts as evidence

The result deliberately separates several concepts:

- `captureSuccess`: HTTP success plus exactly one recognized choice/message,
  zero modern or legacy tool calls, `finish_reason=stop`, and exact trimmed
  text `OK`.
  `tool_calls: null` is a valid no-tool shape; array-valued choices/messages,
  missing/non-string/nonstandard finish reasons, `length`, `content_filter`,
  `function_call`, and `tool_calls` finishes fail closed.
- `finishReasonAudit`: per-choice sanitized status counts split into warmup,
  measurement, and all-request views. Raw finish-reason values are not retained.
- `cacheTelemetryEligible`: capture success, exact requested response-model
  attribution, a valid input/read/write usage envelope, and—for measurements—a
  successful exact-model warmup from the same arm.
- `outputComplianceAudit`: whether the sole returned choice was exact trimmed
  `OK`. Missing, malformed, multi-choice, and mismatched output fails capture
  and cache eligibility; no response text is stored.
- `responseModelAudit`: match, mismatch, and missing counts split into warmup,
  measurement, and all-request views.
- `usageFieldStatusAudit`: absent, valid, malformed, and conflicting alias
  counts for input, cache read, cache write, output, and total tokens.

When multiple recognized aliases are present, they must contain the same
nonnegative safe integer. A malformed or conflicting field retains only its
audit status; source and value are nulled. Cache read/write must each be no
greater than input and their sum must not exceed input. Output/total conflicts
remain visible but do not reduce read/write eligibility. The per-request
read/write sum and every cross-request weighted aggregate must also remain a
safe integer; overflow aborts the campaign before evidence is written.

Read and write summaries are separate. Each reports field coverage, nonzero
coverage, median tokens, median read-or-write/input ratio, and a weighted ratio.
No cost is derived and provider-normalized fields are not assumed comparable
across models.

## Local and live verification

`scripts/cache-stable-tools-wire.test.mjs` runs PSS through the
OpenAI-compatible adapter with a synthetic fetch. It proves canonical wire
order across registry insertion orders, inactive-tool removal from the
executable registry, actual tools-array hashes, and semantic diagnostics. The
runtime suite covers callback isolation, fail-closed selection/model/toolChoice
validation, retry indices, and AI SDK execution behavior.

`scripts/cache-stable-tools-evidence.test.mjs` is a source-coupled regression
check, not an independent verifier. It imports the producer's campaign preset,
source manifest, topology, and request-artifact helpers, then recalculates the
checked-in snapshot. That makes it useful for catching stale evidence and
recorded-view drift, but producer and test can share the same faulty assumption.

`scripts/cache-stable-tools-independent-verifier.mjs` is the authoritative
evidence verifier. It uses only Node.js standard-library imports and does not
import the benchmark producer. From the serialized evidence and current source
bytes, it independently reconstructs the 480-request topology, AB/BA order,
request-body/tool-array/isolation hashes, chronology, response and usage
eligibility, warmup linkage, audits, summaries, comparisons, membership parity,
and the final README report. It also rejects unexpected request fields, raw
content/provider payloads, bearer strings, and key-like values. Schema v3, the
campaign ID, exact source hashes, and full topology must all match, so an older
or interrupted output fails closed.

`scripts/cache-stable-tools-independent-verifier.adversarial.mjs` exercises that
independent path against a complete synthetic schema-v3 campaign and targeted
topology, chronology, source, usage, warmup, audit, summary, order-sensitivity,
and README tampering. `pnpm test` runs this synthetic adversarial suite in CI;
the suite itself does not read the checked-in live snapshot. The normal Vitest
glob also runs the source-coupled regression check, which intentionally rejects
stale evidence once these sources change. The authoritative live-snapshot
verifier remains an explicit command and must not run against the obsolete
pre-campaign schema-v2 artifact.

## Reproduce

Use a disposable credential, enter it without shell echo, and keep the runner
and every manifested implementation/verifier source unchanged until source-hash
verification completes:

```sh
read -rsp 'API key: ' CACHE_BENCH_API_KEY
printf '\n'
export CACHE_BENCH_API_KEY
trap 'unset CACHE_BENCH_API_KEY' EXIT
pnpm benchmark:cache-stable-tools -- --evidence-campaign
unset CACHE_BENCH_API_KEY
trap - EXIT
```

Before spending the live credential, run the independent verifier's synthetic
adversarial suite:

```sh
pnpm test:cache-stable-tools-verifier
```

After the campaign has atomically written fresh schema-v3 evidence, run both
verification paths. Generate the canonical report block without checking the
still-placeholder README, replace the marked block below with that exact
output, and then run the authoritative verifier with README parity enabled:

```sh
pnpm test:cache-stable-tools-evidence
pnpm verify:cache-stable-tools -- --no-readme --print-readme
pnpm verify:cache-stable-tools
```

The default endpoint is
`https://freerouter.minpeter.workers.dev/v1`. The run performs an authenticated
`/models` preflight, rejects redirects so the bearer token cannot be forwarded,
and writes by mode-`0600` temporary file plus atomic rename. The pinned preset
uses 5 models × 8 trials × 3 scenarios × 2 arms × warmup/measurement = 480
Chat Completions requests, plus one `/models` preflight request: 481 HTTP
requests total. There are no hidden retries. The runner checks the 480-request
topology, then re-hashes the runner and complete source manifest before writing;
any mid-campaign drift fails before the atomic rename. Methodology-changing
flags cannot be combined with `--evidence-campaign`; `--help` lists the bounded
exploratory options.

## Artifacts and interpretation

[`latest-freerouter.json`](./latest-freerouter.json) is authoritative only
when its independent verifier and current runner-source hash pass. Snapshot
results and SHA-256 are recorded below after the final run.

[`mistral-response-shape-probe.json`](./mistral-response-shape-probe.json) is a
diagnostic-only, unversioned-source discovery artifact. It records no response
text or credential and showed that the router returned `tool_calls: null` for a
valid no-tool Mistral response. Its SHA-256 is
`d43b238a53dd686445fff02c86c57cfedf7e0e1987780290be3122501addb214`.
It motivated the parser regression test but is not used for an effect estimate;
the final source-hashed campaign is the authoritative parser/effect evidence.

The router's upstream provider, retry behavior, backend affinity,
`system_fingerprint`, cache policy, load, and usage normalization are opaque.
The endpoint does not expose enough bounded metadata to control those variables
without retaining raw provider payloads. Results are observational, dated, and
provider-specific. `not-reported` means no recognized valid field was exposed,
not that no upstream cache exists. Latency is supporting context only.

Native capability must be established separately for a precise
adapter/provider/model/version tuple. The audited
[`@ai-sdk/openai@4.0.15` tool-search implementation](https://github.com/vercel/ai/blob/b8241a6e5592066c0ee1772c32d3ef47d7d7595e/packages/openai/src/tool/tool-search.ts)
and
[`@ai-sdk/anthropic@4.0.15` tool preparation](https://github.com/vercel/ai/blob/6976682b5718f36425521816e6a8c2df8c07faa9/packages/anthropic/src/anthropic-prepare-tools.ts)
do not imply equivalent behavior in `@ai-sdk/openai-compatible` or a router.
Likewise, [Kimi's positioned system-message protocol](https://platform.kimi.ai/docs/guide/use-dynamic-tool-loading)
is a direct-provider, currently `kimi-k3`-specific extension. Any future native
path needs a wire canary for its expected request/replay items and an eager
fallback when the tuple is unknown or the canary fails.

That canary must also assert an explicit MCP approval policy. The OpenAI API
documents approval-before-sharing as its default, while the current AI SDK
OpenAI Responses adapter lowers an omitted setting to
`require_approval: "never"`; a provider-native integration must not rely on
either implicit default. The generic adapter used here also does not normalize
GPT-5.6 `cache_write_tokens`, so this benchmark's separately audited raw write
field is required and a read-hit ratio is never presented as net cost savings.

## Final checked-in snapshot

This section is populated from the source-hashed 480-request campaign before
the pull request is finalized.

<!-- cache-stable-tools-independent-verifier:start -->
Fresh schema-v3 evidence and the verifier-generated report are pending the
final source-frozen campaign.
<!-- cache-stable-tools-independent-verifier:end -->
