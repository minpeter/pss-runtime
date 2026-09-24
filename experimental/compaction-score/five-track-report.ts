import type { FiveTrackReport } from "./five-track-types";

export function renderFiveTrackReport(report: FiveTrackReport): string {
  const lines = [
    "# PSS Runtime 5-track compaction benchmark",
    "",
    "> No single composite score will be used. Separate measurements, estimates, and unmeasured values in each table.",
    `> Quality output budgetSilver \`${report.methodology.qualityOutputBudgetEnforcement}\` Quantity in a way armApplied the same to.`,
    "> Provider token-limit Factor is hard capwas not considered to be, and the amount armof deterministic stateFinal, including summaryThe local capand then evaluated it..",
    "",
    "## Evidence provenance",
    "",
    "| Track | Model | Mode | Status | Artifact SHA-256 | Receipt SHA-256 |",
    "|---|---|---|---|---|---|",
    ...Object.values(report.inputs).map(
      (input) =>
        `| ${input.track} | ${input.model ?? "n/a"} | ${input.mode ?? "n/a"} | ${input.status} | ${input.sha256.slice(0, 19)}... | ${input.receiptSha256?.slice(0, 19) ?? "embedded/null"} |`
    ),
    "",
    "## Same Output Budget Comparison (Measure)",
    "",
    "| Arm | Budget | Retention (Wilson 95%) | Compression | Latency | Valid/Invalid | Cost |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...report.fairness.matchedOutputBudget.cells.map(
      (cell) =>
        `| ${cell.arm} | ${cell.budget} | ${percent(cell.correct / cell.total)} ${interval(cell.wilson95)} | ${number(cell.compressionRatioMean)} | ${milliseconds(cell.latencyMeanMs)} | ${cell.valid}/${cell.invalid} | Not Measured |`
    ),
    "",
    "## Same Quality Budget Comparison (Estimation)",
    "",
    "| Retention target | PSS budget (95%) | pi budget (95%) | pi/PSS ratio (95%) | Bootstrap draws |",
    "|---:|---:|---:|---:|---:|",
    ...report.fairness.matchedQuality.estimates.map(
      (estimate) =>
        `| ${percent(estimate.quality)} | ${estimate.pssBudget.toFixed(1)} ${optionalInterval(estimate.pssBudgetCi95)} | ${estimate.piBudget.toFixed(1)} ${optionalInterval(estimate.piBudgetCi95)} | ${estimate.ratio.toFixed(3)} ${optionalInterval(estimate.ratioCi95)} | ${estimate.bootstrapValidDraws} |`
    ),
    "",
    "## Rate-distortion-latency curve (Measurement)",
    "",
    "| Arm | Budget | Retention | Compression | Latency | Cost |",
    "|---|---:|---:|---:|---:|---:|",
    ...report.curves.rateDistortionLatency.points.map(
      (point) =>
        `| ${point.arm} | ${point.budget} | ${percent(point.retention)} | ${number(point.compressionRatio)} | ${milliseconds(point.latencyMeanMs)} | Not Measured |`
    ),
    "",
    `Quality Pareto (Estimation): ${report.pareto.quality.front.join(", ") || "FREE"}`,
    "",
    "## Downstream coding-agent utility (Measurement)",
    "",
    "| Metric | Full control | Compact |",
    "|---|---:|---:|",
    `| Task success | ${rate(report.curves.utility.summary.fullControlSuccess)} | ${rate(report.curves.utility.summary.compactConditionalSuccess)} |`,
    `| Quality | ${rate(report.curves.utility.summary.fullQuality)} | ${rate(report.curves.utility.summary.compactQuality)} |`,
    `| Latency mean (95%) | ${latency(report.curves.utility.summary.fullLatencyMs)} | ${latency(report.curves.utility.summary.compactLatencyMs)} |`,
    "| Cost | Not Measured | Not Measured |",
    "",
    "## Real People Calibration (Measurement)",
    "",
    `- Annotators: ${report.humanCalibration.annotatorIds.join(", ")}`,
    `- Labels: ${report.humanCalibration.labelCount}`,
    `- Fixture exact agreement: ${percent(report.humanCalibration.humanFixtureAgreement)} ${interval(report.humanCalibration.humanFixtureWilson95)}`,
    `- Candidate semantic agreement: ${percent(report.humanCalibration.semanticAgreement)} ${interval(report.humanCalibration.semanticWilson95)}`,
    `- Multi-rater kappa: ${report.humanCalibration.interRaterKappa?.toFixed(3) ?? "Not Measured"}`,
    `- Packet digest: ${report.humanCalibration.packetContentDigest}`,
    `- Labels digest: ${report.humanCalibration.labelsContentDigest}`,
    "",
    "## Production speculative-overlap (Measurement)",
    "",
    "| Scenario | User block mean (95%) | Dispatch block mean (95%) | Candidate applied | Background overlap |",
    "|---|---:|---:|---:|---:|",
    ...report.fairness.fullProduct.productionOverlap.map(
      (aggregate) =>
        `| ${aggregate.scenario} | ${distribution(aggregate.actualUserBlockMs)} | ${distribution(aggregate.dispatchBlockMs)} | ${rate(aggregate.candidateApplied)} | ${rate(aggregate.overlap)} |`
    ),
    "",
    "## Deadline outcomes / Pareto (Measurement-based estimation)",
    "",
    "| Scenario | Deadline | Provider start | Timeout | Candidate applied | Reliability | Decision latency |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...deadlineRows(report),
    "",
    ...Object.entries(report.pareto.deadline.front).map(
      ([scenario, deadlines]) => `- ${scenario}: ${deadlines.join(", ")} ms`
    ),
    "",
    "Cost is  provider Before there was no rate trackUnmeasured in and not replaced by zero.",
    "",
  ];
  return lines.join("\n");
}

function deadlineRows(report: FiveTrackReport): readonly string[] {
  return Object.entries(report.fairness.fullProduct.deadlines).flatMap(
    ([scenario, deadlines]) =>
      Object.entries(deadlines).map(
        ([deadline, aggregate]) =>
          `| ${scenario} | ${deadline} | ${rate(aggregate.providerStarted)} | ${rate(aggregate.timeout)} | ${rate(aggregate.candidateApplied)} | ${rate(aggregate.reliability)} | ${distribution(aggregate.decisionLatencyMs)} |`
      )
  );
}

function distribution(value: {
  readonly mean: number;
  readonly meanCi95: readonly [number, number];
}): string {
  return `${value.mean.toFixed(1)} ${interval(value.meanCi95)}`;
}

function latency(value: {
  readonly mean: number;
  readonly meanCi95: readonly [number, number];
}): string {
  return `${value.mean.toFixed(1)} ms ${interval(value.meanCi95)}`;
}

function rate(value: {
  readonly rate: number;
  readonly wilson95: readonly [number, number];
}): string {
  return `${percent(value.rate)} ${interval(value.wilson95)}`;
}

function interval(value: readonly [number, number]): string {
  return `[${value[0].toFixed(3)}, ${value[1].toFixed(3)}]`;
}

function optionalInterval(value: readonly [number, number] | null): string {
  return value === null ? "[Unestimated]" : interval(value);
}

function milliseconds(value: number | null): string {
  return value === null ? "Not Measured" : `${value.toFixed(1)} ms`;
}

function number(value: number | null): string {
  return value === null ? "Not Measured" : value.toFixed(3);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
