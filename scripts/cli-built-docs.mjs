// Built-CLI documentation agreement invariants (VAL-CROSS-009..011). The
// README and the coding-agent guidance must identify the actual built CLI
// path (apps/coding-agent/bin/pss.js), the supported help/error commands,
// the build-before-probe ordering, and the closed-loop (non-network)
// validation boundary — and agree with the machine-readable truth: the
// package bin entrypoints, the bin shim's imports, the CLI router, the
// exec/env error sources, the bundle-size baseline, and the ignore rules.
// Static over committed files plus `git ls-files`: no network, no ports, no
// writes; a fresh checkout without dist/ passes. Per-document wording
// checks live in scripts/cli-built-docs-text.mjs (250 pure-LOC ceiling).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_BIN,
  cliDocProblems,
  EXEC_OPTION_ERROR_MESSAGE,
  GUIDANCE_DOCS,
  README_DOCS,
} from "./cli-built-docs-text.mjs";

export const CLI_BIN_TARGET = "./bin/pss.js";
export const CLI_PACKAGE = "apps/coding-agent/package.json";
export const CLI_SOURCE = "apps/coding-agent/src/cli.ts";
export const EXEC_CLI_SOURCE = "apps/coding-agent/src/exec-cli.ts";
export const ENV_SOURCE = "apps/coding-agent/src/env.ts";
export const BUNDLE_BASELINE = "scripts/bundle-size-baseline.json";

// The two dist modules bin/pss.js imports; both must be covered by the
// bundle-size baseline so the probed entrypoint is budget-checked.
export const EXPECTED_BIN_IMPORTS = ["../dist/cli.js", "../dist/env.js"];
export const BUDGETED_CLI_ARTIFACTS = [
  "apps/coding-agent/dist/cli.js",
  "apps/coding-agent/dist/env.js",
];

// The documented CLI entrypoints: exactly what `pss --help` lists.
export const DOCUMENTED_COMMANDS = [
  "exec",
  "extension",
  "help",
  "inspect-thread",
  "rpc",
  "update",
];

const IMPORT_SPECIFIER = /from "(\.[^"]+)"/g;
// Usage lines live inside the formatUsage() string array:
//   "  exec             Run one headless coding task",
const USAGE_COMMAND = /" {2}([a-z][a-z-]*) {2,}/g;
const DISPATCH_COMMAND = /command === "([^"]+)"/g;

function read(root, path) {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}

// The package manifest must expose the documented built path as both bin
// entrypoints and ship bin/ + dist/ in the published artifact set.
export function packageProblems(pkg) {
  const problems = [];
  if (pkg?.bin?.pss !== CLI_BIN_TARGET) {
    problems.push(`package bin.pss must be ${CLI_BIN_TARGET}`);
  }
  if (pkg?.bin?.["pss-coding-agent"] !== CLI_BIN_TARGET) {
    problems.push(`package bin.pss-coding-agent must be ${CLI_BIN_TARGET}`);
  }
  for (const entry of ["bin", "dist"]) {
    if (!(Array.isArray(pkg?.files) && pkg.files.includes(entry))) {
      problems.push(`package files must include "${entry}"`);
    }
  }
  return problems;
}

// The bin shim is the built-output entrypoint: shebang, exactly the two
// dist imports, never a source import (a source import would let a stale or
// missing dist/ pass silently).
export function binProblems(source) {
  const problems = [];
  if (typeof source !== "string" || !source.startsWith("#!/usr/bin/env node")) {
    problems.push(`${CLI_BIN} must start with the node shebang`);
    return problems;
  }
  const imports = [...source.matchAll(IMPORT_SPECIFIER)].map((m) => m[1]);
  for (const specifier of imports) {
    if (!EXPECTED_BIN_IMPORTS.includes(specifier)) {
      problems.push(
        `${CLI_BIN} imports ${specifier}; only ${EXPECTED_BIN_IMPORTS.join(", ")} are allowed (built dist output)`
      );
    }
  }
  for (const expected of EXPECTED_BIN_IMPORTS) {
    if (!imports.includes(expected)) {
      problems.push(`${CLI_BIN} no longer imports ${expected}`);
    }
  }
  return problems;
}

// Command names listed by formatUsage() and dispatched by the router.
export function cliCommandFacts(source) {
  const commandsBlock = source.slice(source.indexOf("Commands:"));
  const usageCommands = [...commandsBlock.matchAll(USAGE_COMMAND)].map(
    (m) => m[1]
  );
  const dispatchCommands = [...source.matchAll(DISPATCH_COMMAND)].map(
    (m) => m[1]
  );
  return { usageCommands, dispatchCommands };
}

export function routerProblems({ usageCommands, dispatchCommands }) {
  const problems = [];
  const documented = [...usageCommands].sort();
  const expected = [...DOCUMENTED_COMMANDS].sort();
  if (documented.join(",") !== expected.join(",")) {
    problems.push(
      `help lists [${documented.join(", ")}]; the documented entrypoints are [${expected.join(", ")}]`
    );
  }
  for (const command of usageCommands) {
    const dispatched =
      command === "help" ||
      dispatchCommands.includes(command) ||
      dispatchCommands.includes(`--${command}`);
    if (!dispatched) {
      problems.push(
        `router never dispatches the documented command ${command}`
      );
    }
  }
  return problems;
}

// The closed-loop error contract must exist in the sources the docs cite:
// a static bounded exec-option error, the documented timeout ceiling, and
// the model-env setup-help mapping in the bin shim.
export function errorContractProblems({ execCliSource, envSource, binSource }) {
  const problems = [];
  if (!execCliSource?.includes(EXEC_OPTION_ERROR_MESSAGE)) {
    problems.push(
      `${EXEC_CLI_SOURCE} lost the static error "${EXEC_OPTION_ERROR_MESSAGE}"`
    );
  }
  if (!execCliSource?.includes("1200")) {
    problems.push(
      `${EXEC_CLI_SOURCE} lost the documented 1-1200 timeout bound`
    );
  }
  if (!envSource?.includes("formatModelEnvSetupHelp")) {
    problems.push(`${ENV_SOURCE} lost the bounded model-env setup help`);
  }
  if (
    !(
      binSource?.includes("isModelEnvValidationError") &&
      binSource?.includes("process.exitCode = 1")
    )
  ) {
    problems.push(
      `${CLI_BIN} no longer maps model-env validation failures to a bounded exit-1 error`
    );
  }
  return problems;
}

// The bundle budget must cover the dist modules the bin shim imports, and
// generated build output must stay ignored and untracked.
export function baselineProblems(baseline) {
  const artifacts = baseline?.artifacts;
  if (typeof artifacts !== "object" || artifacts === null) {
    return [`${BUNDLE_BASELINE} has no artifacts map`];
  }
  return BUDGETED_CLI_ARTIFACTS.filter((path) => !(path in artifacts)).map(
    (path) => `${BUNDLE_BASELINE} does not budget ${path}`
  );
}

export function gitignoreProblems(source) {
  const lines = (source ?? "").split("\n").map((line) => line.trim());
  return lines.includes("dist")
    ? []
    : [".gitignore must ignore generated dist/ build output"];
}

export function trackedOutputProblems(lsFilesOutput) {
  const tracked = (lsFilesOutput ?? "")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return tracked.map((path) => `generated build output is tracked: ${path}`);
}

export function cliBuiltDocsProblems(root = ".") {
  const problems = [];
  const pkgText = read(root, CLI_PACKAGE);
  if (pkgText === null) {
    problems.push(`${CLI_PACKAGE} is missing`);
  } else {
    problems.push(...packageProblems(JSON.parse(pkgText)));
  }
  const binSource = read(root, CLI_BIN);
  if (binSource === null) {
    problems.push(`${CLI_BIN} is missing`);
  } else {
    problems.push(...binProblems(binSource));
  }
  const cliSource = read(root, CLI_SOURCE);
  if (cliSource === null) {
    problems.push(`${CLI_SOURCE} is missing`);
  } else {
    problems.push(...routerProblems(cliCommandFacts(cliSource)));
  }
  problems.push(
    ...errorContractProblems({
      execCliSource: read(root, EXEC_CLI_SOURCE),
      envSource: read(root, ENV_SOURCE),
      binSource,
    })
  );
  const baselineText = read(root, BUNDLE_BASELINE);
  problems.push(
    ...(baselineText === null
      ? [`${BUNDLE_BASELINE} is missing`]
      : baselineProblems(JSON.parse(baselineText)))
  );
  problems.push(...gitignoreProblems(read(root, ".gitignore")));
  const tracked = execFileSync(
    "git",
    ["ls-files", "--", "apps/coding-agent/dist", "packages/runtime/dist"],
    { cwd: root, encoding: "utf8" }
  );
  problems.push(...trackedOutputProblems(tracked));
  for (const doc of README_DOCS) {
    problems.push(...cliDocProblems(doc, read(root, doc), { full: true }));
  }
  for (const doc of GUIDANCE_DOCS) {
    problems.push(...cliDocProblems(doc, read(root, doc), { full: false }));
  }
  // Every documented entrypoint must appear in the coding-agent README so
  // the help listing has a documented counterpart (VAL-CROSS-009).
  const appReadme = read(root, "apps/coding-agent/README.md");
  if (typeof appReadme === "string") {
    for (const command of DOCUMENTED_COMMANDS) {
      if (!appReadme.includes(`pss ${command}`)) {
        problems.push(
          `apps/coding-agent/README.md never documents the \`pss ${command}\` entrypoint`
        );
      }
    }
  }
  return problems;
}
