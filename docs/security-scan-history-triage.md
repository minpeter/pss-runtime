# PR430 historical Gitleaks triage

This record covers the 38 findings from the pinned full-history run
`gitleaks v8.30.1` (run 34318964909). The production workflow remains a full
history scan: `gitleaks git --config .gitleaks.toml --redact .` with checkout
`fetch-depth: 0`. The committed configuration retains the default rules.

## Dispositions

- 18 `generic-api-key` findings in the benchmark and experimental
  `cache-stable-tools/latest-freerouter.json` artifacts are SHA-256 digests of
  implementation source files. The benchmark provenance entries were checked
  against the source blobs; the renamed artifact contains the same entries.
- 16 `generic-api-key` findings in the two historical cache-telemetry evidence
  revisions are SHA-256 digests derived from benchmark run markers. They are
  telemetry identifiers, not authentication material.
- One `generic-api-key` finding is the campaign aggregation test's synthetic
  output-redaction sentinel.
- One `generic-api-key` finding is the adversarial verifier's inert synthetic
  cache-isolation canary used in request-artifact hash assertions.
- Two `cloudflare-api-key` findings are exported Cloudflare API symbol names in
  the public-surface verification list, not keys.

The exceptions are intentionally rule-specific and use `condition = "AND"`:
each combines one historical commit, one exact anchored path, and one exact
anchored extracted value. No rule is disabled, and no broad path, regex, or
history range is allowlisted. The static config validator and
`scripts/security-gitleaks-history.test.mjs` reject widened gates.

## Controls and evidence

Run the integration controls with the checksum-verified workflow binary:

```sh
node scripts/security-gitleaks-controls.mjs /path/to/gitleaks
```

The controls scan actual repository history. They verify the shipped config
returns zero findings, the baseline without historical exceptions returns all
38 findings, and independently mutate the commit, path, and value gates; each
mutation returns the same 38 findings. They also scan runtime-assembled
real-shaped synthetic values and verify the default rules detect both.

Observed output with the pinned binary:

```text
baseline: exit 1, 38 findings
approved: exit 0, 0 findings
wrong-commit: exit 1, 38 findings
wrong-path: exit 1, 38 findings
wrong-value: exit 1, 38 findings
unapproved-credentials: exit 1, 2 findings
```

The full-history production-equivalent scan subsequently reported:

```text
876 commits scanned
no leaks found
```
