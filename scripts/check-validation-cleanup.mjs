// Observe-only post-run cleanup check (VAL-CROSS-013). A validation run
// brackets itself with this harness:
//
//   node scripts/check-validation-cleanup.mjs snapshot --out <file>
//   node scripts/check-validation-cleanup.mjs check --baseline <file> [--out <dir>]
//
// `snapshot` captures the listener inventory (`ss -tlnp`), the
// validator-attributable processes (`ps`), and stores them as the baseline.
// `check` re-captures, diffs against the baseline, adds the untracked
// non-ignored paths from `git status --porcelain`, writes a cleanup-check
// report under the evidence directory, and exits 1 when the post-run
// inventory contains a leaked validator. The check NEVER terminates a
// process: a leak is reported and the owning validator tears it down by the
// PID it recorded at startup. Run from the repository root; not part of
// `pnpm test` (live host inspection, not a deterministic invariant).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  inventoryProblems,
  parseListeners,
  untrackedArtifacts,
  validatorProcesses,
} from "./validation-cleanup.mjs";

const COMMAND_TIMEOUT_MS = 10_000;
const REPORT_FILE = "cleanup-check.json";
const USAGE =
  "usage: check-validation-cleanup.mjs snapshot --out <file> | check --baseline <file> [--out <dir>]";

// Every spawned inventory command is bounded: a hung `ss`/`ps`/`git` fails
// the run instead of leaking a child.
function capture(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

function captureInventory() {
  return {
    capturedAt: new Date().toISOString(),
    listeners: parseListeners(capture("ss", ["-tlnp"])),
    processes: validatorProcesses(capture("ps", ["-eo", "pid=,args="])),
  };
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = {};
  for (let index = 0; index + 1 < rest.length; index += 2) {
    options[rest[index]] = rest[index + 1];
  }
  return { mode, out: options["--out"], baseline: options["--baseline"] };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(out) {
  const inventory = captureInventory();
  writeJson(out, inventory);
  console.log(
    `CLEANUP-SNAPSHOT listeners=${inventory.listeners.length} validator-processes=${inventory.processes.length} out=${out}`
  );
  return 0;
}

function check(baselinePath, out) {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const current = captureInventory();
  const { problems, foreignChurn } = inventoryProblems(baseline, current);
  for (const path of untrackedArtifacts(
    capture("git", ["status", "--porcelain"])
  )) {
    problems.push(`unignored temporary artifact: ${path}`);
  }
  const report = {
    capturedAt: current.capturedAt,
    baseline: baselinePath,
    problems,
    foreignChurn,
    result: problems.length === 0 ? "passed" : "failed",
  };
  writeJson(join(out ?? dirname(baselinePath), REPORT_FILE), report);
  console.log(
    `CLEANUP-CHECK problems=${problems.length} foreign-churn=${foreignChurn.length} result=${report.result}`
  );
  for (const problem of problems) {
    console.error(`CLEANUP-CHECK problem: ${problem}`);
  }
  return problems.length === 0 ? 0 : 1;
}

function main(argv) {
  const { mode, out, baseline } = parseArgs(argv);
  if (mode === "snapshot" && out) {
    return snapshot(out);
  }
  if (mode === "check" && baseline) {
    return check(baseline, out);
  }
  console.error(USAGE);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
