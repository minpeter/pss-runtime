// Pure helpers for the serial two-checkout reproducibility harness
// (VAL-CROSS-014), imported by scripts/check-two-checkout-repro.mjs and
// pinned by scripts/two-checkout-repro.test.mjs. CONTRIBUTING "Fast local
// gates" documents a concrete numeric wall-clock bound for one clean
// checkout's frozen-install + validation-sequence run (analogous to the
// pre-commit ≤ 60 s bound); these helpers pin the documented number to the
// enforced default, parse the deterministic run outputs, and compare the
// two serial runs.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { transcriptProblems } from "./first-run-setup.mjs";

// The enforced default equals the bound documented in CONTRIBUTING.md; the
// invariant test pins the two together.
export const DEFAULT_BOUND_SECONDS = 600;
// Exactly two checkouts, executed serially by the CLI harness.
export const RUN_LABELS = ["run1", "run2"];

export const DEFAULT_OUT = ".omo/evidence/two-checkout-repro";

// Vitest may print "N passed | M skipped (T)" — the totals sit at end of
// line, so skip any middle segments when parsing.
const TEST_FILES_LINE = /Test Files\s+(\d+) passed[^\n]*\((\d+)\)/;
const TESTS_LINE = /Tests\s+(\d+) passed[^\n]*\((\d+)\)/;
const BOUND_ROW = /check:two-checkout-repro[^\n]*?≤\s*(\d+)\s*s/;

// The documented per-checkout bound must exist and match the harness.
export function documentedBoundProblems(contributingText) {
  const match = contributingText.match(BOUND_ROW);
  if (!match) {
    return [
      "CONTRIBUTING.md documents no numeric wall-clock bound for the two-checkout reproducibility run",
    ];
  }
  const documented = Number(match[1]);
  return documented === DEFAULT_BOUND_SECONDS
    ? []
    : [
        `CONTRIBUTING.md documents a ${documented}s per-checkout bound but the harness enforces ${DEFAULT_BOUND_SECONDS}s`,
      ];
}

// Pass/total counts from the (ANSI-coloured) vitest summary; timing lines
// are deliberately excluded so the digest stays deterministic.
export function parseVitestSummary(text) {
  const plain = stripVTControlCharacters(text);
  const files = plain.match(TEST_FILES_LINE);
  const tests = plain.match(TESTS_LINE);
  if (!(files && tests)) {
    return null;
  }
  return {
    testFiles: [Number(files[1]), Number(files[2])],
    tests: [Number(tests[1]), Number(tests[2])],
  };
}

const DIGEST_FIELDS = [
  "steps",
  "suites",
  "summary",
  "discoveryProblems",
  "checkoutStatus",
];

// Deterministic outputs of the two serial runs must agree field by field.
export function compareDigests(first, second) {
  return DIGEST_FIELDS.filter(
    (field) => JSON.stringify(first[field]) !== JSON.stringify(second[field])
  ).map(
    (field) =>
      `deterministic output "${field}" disagrees between the two serial checkout runs`
  );
}

// Every checkout run must finish within the documented per-checkout bound.
export function elapsedProblems(runs, bound) {
  return runs
    .filter((run) => run.seconds > bound)
    .map(
      (run) =>
        `${run.label} ran ${run.seconds.toFixed(1)}s, over the documented ${bound}s per-checkout bound`
    );
}

const COMMAND_TIMEOUT_MS = 10_000;

// Trimmed `git status --porcelain` for a tree, or a failure marker.
export function gitPorcelain(cwd) {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
  });
  return result.status === 0 ? result.stdout.trim() : `exit ${result.status}`;
}

// Scan every captured transcript for credential prompts / production
// endpoints after all steps ran.
export function transcriptScan(outDir, problems) {
  for (const file of readdirSync(outDir).sort()) {
    if (file.endsWith(".log")) {
      problems.push(
        ...transcriptProblems(file, readFileSync(join(outDir, file), "utf8"))
      );
    }
  }
}
