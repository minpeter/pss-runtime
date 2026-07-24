import { buildCompactionSummaryInstructions } from "@minpeter/pss-runtime";
import type { BenchmarkScenario } from "./fixture";
import { buildBatchedQuestionPrompt } from "./protocol";
import { BENCHMARK_SCENARIOS, buildScenarioFixture } from "./scenario-fixtures";

const specs =
  process.argv.length > 2
    ? process.argv.slice(2)
    : BENCHMARK_SCENARIOS.map(
        (scenario) => `${scenario}=compaction-score-v3-${scenario}`
      );

const packets = specs.map((spec) => {
  const { scenario, seed } = parseSpec(spec);
  const fixture = buildScenarioFixture(scenario, seed);
  return {
    compactionEnds: fixture.compactionEnds,
    evaluationPrompt: buildBatchedQuestionPrompt(fixture.questions),
    messages: fixture.messages,
    questions: fixture.questions,
    scenario,
    seed,
    summaryInstructions: buildCompactionSummaryInstructions(),
  };
});

console.log(JSON.stringify(packets));

function parseSpec(spec: string): {
  readonly scenario: BenchmarkScenario;
  readonly seed: string;
} {
  const separator = spec.indexOf("=");
  if (separator === -1) {
    return { scenario: "baseline", seed: spec };
  }
  const scenario = spec.slice(0, separator);
  const seed = spec.slice(separator + 1);
  if (!BENCHMARK_SCENARIOS.includes(scenario as BenchmarkScenario)) {
    throw new TypeError(`Unknown benchmark scenario: ${scenario}`);
  }
  return { scenario: scenario as BenchmarkScenario, seed };
}
