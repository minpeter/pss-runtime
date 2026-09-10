// Shared CLI glue for the clean-checkout harnesses
// (scripts/fresh-checkout-setup.mjs, VAL-CROSS-001 and
// scripts/check-two-checkout-repro.mjs, VAL-CROSS-014): the transcript-
// capturing spawn wrapper, the OK/FAIL step reporter, and the --help/error
// early-exit prologue. Behaviour is identical to the inlined copies the two
// harnesses started with.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_BUFFER = 64 * 1024 * 1024;
const STEP_TIMEOUT_MS = 10 * 60 * 1000;

// Run one harness step, capturing a labelled transcript under outDir.
export function run(label, command, commandArgs, options, outDir) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: STEP_TIMEOUT_MS,
    ...options,
  });
  const transcript = [
    `$ ${command} ${commandArgs.join(" ")}`,
    `exit=${result.status}${result.error ? ` error=${result.error.message}` : ""}`,
    result.stdout,
    result.stderr,
  ].join("\n");
  writeFileSync(join(outDir, `${label}.log`), transcript);
  return result;
}

// OK/FAIL step reporter that collects named problems.
export function makeStep(problems) {
  return (label, ok, detail = "") => {
    console.log(
      `${ok ? "OK  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`
    );
    if (!ok) {
      problems.push(`${label}: ${detail || "failed"}`);
    }
    return ok;
  };
}

// The shared main() prologue: print usage on --help or a parse error and
// return the exit code, or null when the harness should proceed.
export function earlyExit(args, usage) {
  if (args.error) {
    console.error(`${args.error}\n\n${usage}`);
    return 2;
  }
  if (args.help) {
    console.log(usage);
    return 0;
  }
  return null;
}
