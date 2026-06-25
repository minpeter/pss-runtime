---
"@minpeter/pss-runtime": patch
---

Add a `./evals` subpath for running repeatable checks against the real agent
runtime. Evals drive a live `Agent` thread, drain its event stream into a
normalized `EvalRun`, and assert the three questions that matter: did it call
the right tool, did it avoid the dangerous tool, and did it say the right thing.

There is no separate eval universe and no new runtime dependency — the layer
reuses the existing `ai` runtime. `defineEval` registers suites, `expect()`
provides `toHaveCalledTools` / `not.toHaveCalledTools` / `toContain` /
`toMatch` matchers, and `runEvals()` produces a report. A `pss-eval` CLI
discovers `*.eval.ts` files, runs them, prints a summary, and exits non-zero on
failure.
