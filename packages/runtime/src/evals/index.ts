// biome-ignore-all lint/performance/noBarrelFile: Subpath entrypoint re-exports the public evals API; callers import named symbols from it.
// pss-runtime evals: run repeatable checks against the real agent runtime, with
// an eve-style multi-verdict engine (record-based assertions, gate/soft
// severity, tool input/output matchers). No separate eval universe and no new
// runtime dependency — evals drive a real Agent thread and drain its event stream.

export { summarizeCacheUsage } from "./cache";
export type { ParsedArgs } from "./cli";
export { compileFilters, discoverEvalFiles, parseArgs, runCli } from "./cli";
export { formatJsonReport, formatTextReport } from "./format";
export { runAgent } from "./harness";
export { type JudgeVerdict, runJudge } from "./judge";
export {
  equals,
  includes,
  matches,
  similarity,
} from "./matchers";
export { clearEvals, defineEval, type EvalIt, getEvals } from "./registry";
export { runEvals } from "./runner";
export { EvalScopeImpl } from "./scope";
export type { StandardSchemaResult, StandardSchemaV1 } from "./standard-schema";
export type {
  AgentTurnLike,
  AssertionHandle,
  AssertionRecord,
  AssertionSeverity,
  CacheHitRateOptions,
  CaseResult,
  EvalCacheStats,
  EvalCase,
  EvalDefinition,
  EvalOptions,
  EvalReport,
  EvalRun,
  EvalScope,
  EvalThreadLike,
  EvalToolCall,
  EvalToolResult,
  FieldMatcher,
  JudgeAutoevals,
  JudgeCallOptions,
  JudgeSurface,
  RunEvalsOptions,
  SchemaInput,
  ToolCallMatcherOptions,
  ValueBuilder,
} from "./types";
