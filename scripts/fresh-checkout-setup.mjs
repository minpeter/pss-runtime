#!/usr/bin/env node
// Fresh-checkout harness (VAL-CROSS-001): clone the committed tree into a
// clean scratch directory, run the documented package-manager setup
// (`pnpm install --frozen-lockfile`), run the repository invariant tests,
// then the command-discovery check and one real advertised gate
// (`pnpm lint`). Every transcript is captured under --out; the harness fails
// on any credential prompt, production endpoint, or undocumented
// prerequisite. Scratch state is removed afterwards unless --keep is given.

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
import { firstRunProblems, transcriptProblems } from "./first-run-setup.mjs";

const DEFAULT_OUT = join(".omo", "evidence", "first-run-setup");

const USAGE = `Usage: node scripts/fresh-checkout-setup.mjs [--out <dir>] [--keep]

Clone HEAD into a clean scratch checkout, run the documented setup
(pnpm install --frozen-lockfile), the repository invariant tests
(scripts/*.test.mjs), the command-discovery check, and pnpm lint; capture
transcripts under --out (default: ${DEFAULT_OUT}). Exits non-zero when any
step fails or a transcript shows a credential prompt or production endpoint.

Options:
  --out <dir>   evidence directory (default: ${DEFAULT_OUT})
  --keep        keep the scratch checkout afterwards
  --help        print this usage and exit 0`;

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, keep: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--keep") {
      args.keep = true;
    } else if (token === "--out") {
      const value = argv[index + 1];
      if (value === undefined) {
        return { error: "option --out requires a value" };
      }
      args.out = value;
      index += 1;
    } else {
      return { error: `unknown option: ${token}` };
    }
  }
  return args;
}

const NODE_VERSION_OK = /^v24\./;
const PNPM_VERSION = "11.9.0";

// Documented toolchain preflight: the harness itself must run on the Node 24
// / pnpm 11.9.0 setup the docs advertise.
function preflight(args, step) {
  const node = run(
    "preflight-node",
    process.execPath,
    ["--version"],
    {},
    args.out
  );
  const nodeOk = NODE_VERSION_OK.test((node.stdout ?? "").trim());
  step("preflight node", nodeOk, (node.stdout ?? "").trim());
  const pnpm = run("preflight-pnpm", "pnpm", ["--version"], {}, args.out);
  const pnpmOk = (pnpm.stdout ?? "").trim() === PNPM_VERSION;
  step("preflight pnpm", pnpmOk, (pnpm.stdout ?? "").trim());
  return nodeOk && pnpmOk;
}

// Scan every captured transcript for credential prompts / production
// endpoints after all steps ran.
function transcriptScan(outDir, problems) {
  for (const file of readdirSync(outDir).sort()) {
    if (!file.endsWith(".log")) {
      continue;
    }
    problems.push(
      ...transcriptProblems(file, readFileSync(join(outDir, file), "utf8"))
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const early = earlyExit(args, USAGE);
  if (early !== null) {
    return early;
  }
  mkdirSync(args.out, { recursive: true });
  const problems = [];
  const step = makeStep(problems);
  if (!preflight(args, step)) {
    return 1;
  }

  const cache = join(homedir(), ".cache");
  mkdirSync(cache, { recursive: true });
  const scratch = mkdtempSync(join(cache, "pss-first-run-"));
  const checkout = join(scratch, "checkout");
  const env = { ...process.env, CI: "1" };
  try {
    const clone = run(
      "clone",
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
    if (
      !step(
        "clone",
        clone.status === 0 && existsSync(join(checkout, "package.json"))
      )
    ) {
      return 1;
    }

    const install = run(
      "install",
      "pnpm",
      ["install", "--frozen-lockfile"],
      { cwd: checkout, env },
      args.out
    );
    step(
      "documented setup (pnpm install --frozen-lockfile)",
      install.status === 0
    );

    const tmpdir = join(checkout, ".omo", "tmp");
    mkdirSync(tmpdir, { recursive: true });
    const suites = readdirSync(join(checkout, "scripts"))
      .filter((file) => file.endsWith(".test.mjs"))
      .sort()
      .map((file) => join("scripts", file));
    const invariants = run(
      "invariants",
      process.execPath,
      [
        join(checkout, "node_modules", "vitest", "vitest.mjs"),
        "run",
        ...suites,
      ],
      { cwd: checkout, env: { ...env, TMPDIR: tmpdir } },
      args.out
    );
    step(
      "repository invariant tests",
      invariants.status === 0,
      `${suites.length} suites`
    );

    const discovery = firstRunProblems(checkout);
    writeFileSync(
      join(args.out, "discovery.json"),
      `${JSON.stringify({ checkout: "HEAD", problems: discovery }, null, 2)}\n`
    );
    step(
      "command-discovery check",
      discovery.length === 0,
      `${discovery.length} problems`
    );

    const lint = run(
      "lint",
      "pnpm",
      ["lint"],
      { cwd: checkout, env },
      args.out
    );
    step("advertised gate (pnpm lint)", lint.status === 0);

    transcriptScan(args.out, problems);
  } finally {
    if (args.keep) {
      console.log(`scratch checkout kept at ${checkout}`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`FAIL ${problem}`);
    }
    return 1;
  }
  console.log(
    "first-run setup OK: documented setup completed with no credentials; every documented validation entrypoint resolved; no production endpoint or undocumented service used"
  );
  return 0;
}

process.exit(main());
