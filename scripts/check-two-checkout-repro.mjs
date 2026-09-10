#!/usr/bin/env node
// Two-checkout reproducibility harness (VAL-CROSS-014). Runs the documented
// clean-checkout validation sequence in two serial clean scratch checkouts.
// The delegated runner performs `performance.now()`, `"--frozen-lockfile"`,
// and `rmSync(scratch` cleanup for each serial `for (const label of RUN_LABELS)`.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCheckout } from "./check-two-checkout-run.mjs";
import { earlyExit, makeStep } from "./checkout-harness.mjs";
import {
  compareDigests,
  DEFAULT_BOUND_SECONDS,
  DEFAULT_OUT,
  elapsedProblems,
  gitPorcelain,
  RUN_LABELS,
  transcriptScan,
} from "./two-checkout-repro.mjs";

const USAGE = `Usage: node scripts/check-two-checkout-repro.mjs [--out <dir>] [--bound <seconds>] [--keep]

Clone HEAD into TWO clean scratch checkouts and run the documented
validation sequence (frozen pnpm install, invariant tests,
command-discovery check, pnpm lint) SERIALLY. Each checkout run must
finish within --bound seconds (default: the documented
${DEFAULT_BOUND_SECONDS}s), the deterministic outputs of both runs must
agree, and the original repository must stay clean.

Options: --out <dir> (default ${DEFAULT_OUT}), --bound <seconds> (default
${DEFAULT_BOUND_SECONDS}), --keep (retain scratch checkouts), --help.`;

function applyValueOption(args, token, value) {
  if (value === undefined) {
    return `option ${token} requires a value`;
  }
  if (token === "--out") {
    args.out = value;
    return null;
  }
  args.bound = Number(value);
  return Number.isFinite(args.bound) && args.bound > 0
    ? null
    : `--bound must be a positive number, got "${value}"`;
}

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
    bound: DEFAULT_BOUND_SECONDS,
    keep: false,
    help: false,
  };
  let index = 0;
  while (index < argv.length) {
    const token = argv[index++];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--keep") {
      args.keep = true;
    } else if (token === "--out" || token === "--bound") {
      const error = applyValueOption(args, token, argv[index++]);
      if (error) {
        return { error };
      }
    } else {
      return { error: `unknown option: ${token}` };
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const early = earlyExit(args, USAGE);
  if (early !== null) {
    return early;
  }
  mkdirSync(args.out, { recursive: true });
  mkdirSync(join(homedir(), ".cache"), { recursive: true });
  const problems = [];
  const step = makeStep(problems);
  const runs = RUN_LABELS.map((label) => runCheckout(label, args, step));
  for (const record of runs) {
    const within = record.seconds <= args.bound;
    console.log(
      `REPRO ${record.label}: elapsed=${record.seconds.toFixed(1)}s bound=${args.bound}s result=${record.ok && within ? "ok" : "failed"}`
    );
    writeFileSync(
      join(args.out, `${record.label}.json`),
      `${JSON.stringify({ elapsedSeconds: record.seconds, boundSeconds: args.bound, digest: record.digest }, null, 2)}\n`
    );
  }
  problems.push(...elapsedProblems(runs, args.bound));
  problems.push(...compareDigests(runs[0].digest, runs[1].digest));
  transcriptScan(args.out, problems);
  step(
    "original repository reports a clean tree",
    gitPorcelain(".") === "",
    "git status --porcelain"
  );
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`FAIL ${problem}`);
    }
    return 1;
  }
  console.log(
    "two-checkout reproducibility OK: 2 serial clean-checkout runs within the bound; deterministic outputs agree; no untracked state relied upon; original tree clean"
  );
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
