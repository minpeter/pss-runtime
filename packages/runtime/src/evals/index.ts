// biome-ignore-all lint/performance/noBarrelFile: Subpath entrypoint re-exports the public evals API; callers import named symbols from it.
// pss-runtime evals: run repeatable checks against the real agent runtime.
//
// No separate eval universe - evals drive a real `Agent` thread, drain its
// event stream into a normalized `EvalRun`, and assert the three questions
// that matter: did it call the right tool, did it avoid the dangerous tool,
// and did it say the right thing.

export type { ParsedArgs } from "./cli";
export { compileFilters, discoverEvalFiles, parseArgs, runCli } from "./cli";
export {
  EvalAssertionError,
  type EvalMatchers,
  expect,
} from "./expect";
export { formatJsonReport, formatTextReport } from "./format";
export { runAgent } from "./harness";
export { clearEvals, defineEval, type EvalIt, getEvals } from "./registry";
export { runEvals } from "./runner";
export type {
  AgentTurnLike,
  CaseResult,
  EvalCase,
  EvalCaseContext,
  EvalDefinition,
  EvalOptions,
  EvalReport,
  EvalRun,
  EvalThreadLike,
  EvalToolCall,
  EvalToolResult,
  RunEvalsOptions,
} from "./types";
