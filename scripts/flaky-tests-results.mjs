import { resolve } from "node:path";

const SKIPPED = new Set(["skipped", "pending"]);
export const ENTRY_STATUSES = new Set([
  "passed",
  "flaky",
  "failed",
  "skipped",
  "todo",
  "incomplete",
]);
const RUN_STATUSES = new Set(["passed", "failed", "todo", ...SKIPPED]);

// Only actual pass/fail observations establish flakiness. Missing or unknown
// observations never establish a pass, and legitimate skips are not failures.
export function classifyOutcomes(outcomes) {
  const passes = outcomes.includes("passed");
  const failures = outcomes.includes("failed");
  if (passes && failures) {
    return "flaky";
  }
  if (failures) {
    return "failed";
  }
  if (
    !outcomes.length ||
    outcomes.some((status) => !RUN_STATUSES.has(status))
  ) {
    return "incomplete";
  }
  if (outcomes.every((status) => status === "passed")) {
    return "passed";
  }
  if (outcomes.every((status) => status === "todo")) {
    return "todo";
  }
  return "skipped";
}

function testKey(file, assertion) {
  return JSON.stringify([file.name, assertion.fullName ?? assertion.title]);
}

function collectFile(file, keys, files, problems, run) {
  if (
    typeof file?.name !== "string" ||
    !Array.isArray(file.assertionResults) ||
    file.assertionResults.length === 0
  ) {
    problems.push(`run ${run} has a file without assertions or a name`);
    return 0;
  }
  files.add(resolve(file.name));
  if (file.status === "failed") {
    problems.push(`run ${run} has a failed file: ${file.name}`);
  }
  for (const assertion of file.assertionResults) {
    if (
      typeof (assertion?.fullName ?? assertion?.title) !== "string" ||
      !RUN_STATUSES.has(assertion?.status)
    ) {
      problems.push(`run ${run} has an invalid assertion`);
      continue;
    }
    const key = testKey(file, assertion);
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  return file.assertionResults.length;
}

// Validate at the child-process boundary before aggregation. A collection
// failure may produce valid JSON with no assertions or only a partial suite.
export function flakyRunProblems(reports, expectedFiles = []) {
  const problems = [];
  let expected;
  for (const [index, report] of reports.entries()) {
    const keys = new Map();
    const files = new Set();
    let count = 0;
    if (
      !Array.isArray(report?.testResults) ||
      report.testResults.length === 0
    ) {
      problems.push(`run ${index + 1} has no test results`);
      continue;
    }
    if (report.success === false || report.numRuntimeErrorTestSuites > 0) {
      problems.push(`run ${index + 1} reports a suite failure`);
    }
    for (const file of report.testResults) {
      count += collectFile(file, keys, files, problems, index + 1);
    }
    if (report.numTotalTests !== undefined && report.numTotalTests !== count) {
      problems.push(`run ${index + 1} has incomplete assertion results`);
    }
    if (expectedFiles.some((file) => !files.has(resolve(file)))) {
      problems.push(`run ${index + 1} is missing a requested test file`);
    }
    if (
      expected &&
      (keys.size !== expected.size ||
        [...expected].some(([key, count]) => keys.get(key) !== count))
    ) {
      problems.push(`run ${index + 1} is missing or has extra test entries`);
    }
    expected ??= keys;
  }
  return problems;
}

function relativeFile(name) {
  const cwd = process.cwd();
  const path = String(name ?? "unknown");
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

export function aggregateRunReports(reports) {
  const outcomes = new Map();
  for (const [run, report] of reports.entries()) {
    if (!Array.isArray(report?.testResults)) {
      continue;
    }
    const occurrences = new Map();
    for (const file of report.testResults) {
      if (!Array.isArray(file?.assertionResults)) {
        continue;
      }
      const relative = relativeFile(file.name);
      for (const assertion of file.assertionResults) {
        const title = String(assertion?.fullName ?? assertion?.title ?? "?");
        const identity = JSON.stringify([relative, title]);
        const occurrence = occurrences.get(identity) ?? 0;
        occurrences.set(identity, occurrence + 1);
        const key = JSON.stringify([identity, occurrence]);
        if (!outcomes.has(key)) {
          outcomes.set(key, {
            file: relative,
            name: title,
            results: new Array(reports.length).fill("missing"),
          });
        }
        outcomes.get(key).results[run] = assertion?.status ?? "unknown";
      }
    }
  }
  return [...outcomes.values()]
    .map((entry) => ({
      file: entry.file,
      name: entry.name,
      status: classifyOutcomes(entry.results),
      runs: reports.length,
      failures: entry.results.filter((result) => result === "failed").length,
    }))
    .sort((a, b) => `${a.file} ${a.name}`.localeCompare(`${b.file} ${b.name}`));
}
