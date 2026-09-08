#!/usr/bin/env node
// Two-checkout reproducibility harness (VAL-CROSS-014). Runs the documented
// clean-checkout validation sequence — frozen `pnpm install`, the repository
// invariant tests, the command-discovery check, and `pnpm lint` — in TWO
// clean temporary checkouts of HEAD, one at a time (serial, inside the
// cross-area concurrency budget), each within the per-checkout wall-clock
// bound documented in CONTRIBUTING "Fast local gates". The deterministic
// outputs of both runs must agree, both elapsed times are captured, and the
// original repository must report a clean tree afterwards. Transcripts and
// per-run records land under --out (gitignored); scratch checkouts are
// removed unless --keep is given. On demand only — never part of pnpm test.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { earlyExit, makeStep, run } from "./checkout-harness.mjs";
import { firstRunProblems } from "./first-run-setup.mjs";
import {
  compareDigests,
  DEFAULT_BOUND_SECONDS,
  DEFAULT_OUT,
  elapsedProblems,
  gitPorcelain,
  parseVitestSummary,
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

function setValueOption(args, token, value) {
  if (value === undefined) {
    return `option ${token} requires a value`;
  }
  if (token === "--out") {
    args.out = value;
    return null;
  }
  args.bound = Number(value);
  if (!Number.isFinite(args.bound) || args.bound <= 0) {
    return `--bound must be a positive number, got "${value}"`;
  }
  return null;
}

function parseArgs(argv) {
  const args = {
    out: DEFAULT_OUT,
    bound: DEFAULT_BOUND_SECONDS,
    keep: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--keep") {
      args.keep = true;
    } else if (token === "--out" || token === "--bound") {
      const error = setValueOption(args, token, argv[index + 1]);
      if (error) {
        return { error };
      }
      index += 1;
    } else {
      return { error: `unknown option: ${token}` };
    }
  }
  return args;
}

// One clean-checkout run: clone HEAD, then the documented validation
// sequence, timed from the frozen install to the advertised lint gate.
function runCheckout(label, args, step) {
  const scratch = mkdtempSync(join(homedir(), ".cache", "pss-repro-"));
  const checkout = join(scratch, "checkout");
  const env = { ...process.env, CI: "1" };
  const digest = {
    steps: {},
    suites: [],
    summary: null,
    discoveryProblems: [],
    checkoutStatus: "",
  };
  let ok = true;
  try {
    const clone = run(
      `${label}-clone`,
      "git",
      [
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--no-local",
        resolve("."),
        checkout,
      ],
      {},
      args.out
    );
    ok =
      step(
        `${label} clone`,
        clone.status === 0 && existsSync(join(checkout, "package.json"))
      ) && ok;
    const started = performance.now();
    const install = run(
      `${label}-install`,
      "pnpm",
      ["install", "--frozen-lockfile"],
      { cwd: checkout, env },
      args.out
    );
    digest.steps.install = install.status;
    ok = step(`${label} frozen install`, install.status === 0) && ok;
    const tmpdir = join(checkout, ".omo", "tmp");
    mkdirSync(tmpdir, { recursive: true });
    digest.suites = readdirSync(join(checkout, "scripts"))
      .filter((file) => file.endsWith(".test.mjs"))
      .sort();
    const invariants = run(
      `${label}-invariants`,
      process.execPath,
      [
        join(checkout, "node_modules", "vitest", "vitest.mjs"),
        "run",
        ...digest.suites.map((file) => join("scripts", file)),
      ],
      { cwd: checkout, env: { ...env, TMPDIR: tmpdir } },
      args.out
    );
    digest.steps.invariants = invariants.status;
    digest.summary = parseVitestSummary(
      readFileSync(join(args.out, `${label}-invariants.log`), "utf8")
    );
    ok =
      step(
        `${label} repository invariant tests`,
        invariants.status === 0 && digest.summary !== null,
        `${digest.suites.length} suites`
      ) && ok;
    digest.discoveryProblems = firstRunProblems(checkout);
    ok =
      step(
        `${label} command-discovery check`,
        digest.discoveryProblems.length === 0,
        `${digest.discoveryProblems.length} problems`
      ) && ok;
    const lint = run(
      `${label}-lint`,
      "pnpm",
      ["lint"],
      { cwd: checkout, env },
      args.out
    );
    digest.steps.lint = lint.status;
    ok = step(`${label} advertised gate (pnpm lint)`, lint.status === 0) && ok;
    digest.checkoutStatus = gitPorcelain(checkout);
    ok =
      step(
        `${label} checkout relies on no untracked state`,
        digest.checkoutStatus === ""
      ) && ok;
    const seconds = (performance.now() - started) / 1000;
    return { label, seconds, digest, ok };
  } finally {
    if (args.keep) {
      console.log(`${label} scratch checkout kept at ${checkout}`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
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
  const runs = [];
  // Serial execution: each checkout completes (install + validation + scratch
  // removal) before the next clone starts — never two at once.
  for (const label of RUN_LABELS) {
    runs.push(runCheckout(label, args, step));
  }
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
    `two-checkout reproducibility OK: 2 serial clean-checkout runs within the ${args.bound}s per-checkout bound; deterministic outputs agree; no untracked state relied upon; original tree clean`
  );
  return 0;
}

process.exit(main());
