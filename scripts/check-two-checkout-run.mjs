import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "./checkout-harness.mjs";
import { firstRunProblems } from "./first-run-setup.mjs";
import { parseVitestSummary } from "./two-checkout-repro.mjs";

const GATE_RESULT_LINE = /GATE [^\n]*\n$/;

export function runCheckout(
  label,
  args,
  step,
  { runCommand = run, now = () => performance.now() } = {}
) {
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
  let started;
  const record = () => ({
    label,
    seconds: (now() - started) / 1000,
    digest,
    ok,
  });
  const boundedRun = (name, command, commandArgs, options) => {
    const remaining = args.bound * 1000 - (now() - started);
    if (remaining <= 0) {
      throw new Error("checkout deadline exhausted");
    }
    return runCommand(
      name,
      process.execPath,
      [
        resolve("scripts/time-gate.mjs"),
        "--bound",
        String(remaining / 1000),
        "--label",
        name,
        "--",
        command,
        ...commandArgs,
      ],
      {
        ...options,
        timeout: Math.ceil(remaining) + 5000,
        killSignal: "SIGKILL",
      },
      args.out
    );
  };
  try {
    started = now();
    const clone = boundedRun(
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
      {}
    );
    ok =
      step(
        `${label} clone`,
        clone.status === 0 && existsSync(join(checkout, "package.json"))
      ) && ok;
    if (!ok) {
      return record();
    }
    const install = boundedRun(
      `${label}-install`,
      "pnpm",
      ["install", "--frozen-lockfile"],
      { cwd: checkout, env }
    );
    digest.steps.install = install.status;
    ok = step(`${label} frozen install`, install.status === 0) && ok;
    if (install.status !== 0) {
      return record();
    }
    digest.suites = readdirSync(join(checkout, "scripts"))
      .filter((file) => file.endsWith(".test.mjs"))
      .sort();
    const invariants = boundedRun(
      `${label}-invariants`,
      process.execPath,
      [
        join(checkout, "node_modules", "vitest", "vitest.mjs"),
        "run",
        ...digest.suites.map((file) => join("scripts", file)),
      ],
      { cwd: checkout, env }
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
    if (invariants.status !== 0) {
      return record();
    }
    digest.discoveryProblems = firstRunProblems(checkout);
    ok =
      step(
        `${label} command-discovery check`,
        digest.discoveryProblems.length === 0,
        `${digest.discoveryProblems.length} problems`
      ) && ok;
    const lint = boundedRun(`${label}-lint`, "pnpm", ["lint"], {
      cwd: checkout,
      env,
    });
    digest.steps.lint = lint.status;
    ok = step(`${label} advertised gate (pnpm lint)`, lint.status === 0) && ok;
    if (lint.status !== 0) {
      return record();
    }
    const status = boundedRun(
      `${label}-status`,
      "git",
      ["status", "--porcelain"],
      { cwd: checkout, env }
    );
    digest.checkoutStatus =
      status.status === 0
        ? status.stdout.replace(GATE_RESULT_LINE, "").trim()
        : `exit ${status.status}`;
    ok =
      step(
        `${label} checkout relies on no untracked state`,
        digest.checkoutStatus === ""
      ) && ok;
    return record();
  } catch (error) {
    if (error.message !== "checkout deadline exhausted") {
      throw error;
    }
    ok = step(`${label} per-checkout deadline`, false);
    return record();
  } finally {
    if (args.keep) {
      console.log(`${label} scratch checkout kept at ${checkout}`);
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
