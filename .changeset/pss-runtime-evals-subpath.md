---
"@minpeter/pss-runtime": patch
---

Rework `./evals` into an eve-parity, record-based evaluation engine.

Evals drive a real `Agent` thread and drain its event stream — no separate eval
universe, no new runtime dependency. The assertion model now records results
rather than throwing on the first failure, so a single run reports every failing
assertion (eve-style multi-verdict).

New assertion surface on the per-case scope `t`:
- run-level: `calledTool(name, { input, output, times })`,
  `notCalledTool`, `toolOrder`, `usedNoTools`, `maxToolCalls`,
  `messageIncludes`, `completed`, `didNotFail`, `noFailedActions`, `event`,
  `outputEquals`, `outputMatches`
- value assertions via `t.check(value, builder)` with `includes`, `equals`,
  `matches` (Standard Schema / Zod), `similarity` (Levenshtein)
- severity on every assertion: `.gate()` (hard, default), `.soft()`,
  `.atLeast(threshold)` (tracked, fatal only under `--strict`)

Tool matchers accept literal (partial-deep), RegExp, or predicate. The runner
computes a gate-based verdict, tracks soft misses ("scored"), and the `pss-eval`
CLI gains `--strict` (soft-threshold misses also fail).

LLM judge (`t.judge.autoevals.closedQA / factuality / summarizes`): the only
model-backed assertions, soft by default, graded via a resolved judge model
(`judge: { model }` per-eval or per-call `{ model }`), never the agent under
test. Judge assertions are declared synchronously during the test and resolved
by the runner after the test function runs, so `.atLeast`/`.gate` chain without
`await`. Calling `t.judge.*` with no judge model records a failed gate.

This is a breaking change to the eval authoring API: cases now receive a
recording scope (`t`) instead of `{ run }` + a throw-based `expect`. Multi-turn
cases accumulate state across `t.run()` calls.
