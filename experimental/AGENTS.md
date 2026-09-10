# experimental

Private benchmarks and QA harnesses that call live providers — they cost
money. `PSS_BENCH_MODEL` picks the benchmark model.

## Rules

- Never run live-provider benchmarks as part of routine validation; the
  credentialed paths stay behind the CI secret gate.
- nextjs-bench result campaigns are generated output kept at the
  repository-level .artifacts/nextjs-bench/ path, outside workspace package
  boundaries (`pnpm boundaries` moves legacy output there); never commit
  them.
- `compaction-score` follows the paired CLI/validator convention: every CLI
  experiment ships with the validator that scores its output.
