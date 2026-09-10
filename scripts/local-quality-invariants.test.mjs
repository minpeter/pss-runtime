import { describe, expect, it } from "vitest";
import {
  CHECK_AREAS,
  CI_WORKFLOW_PATH,
  CONTRIBUTING_PATH,
  checkFiles,
  ciWiringProblems,
  gateBoundProblems,
  HOOK_PATH,
  heavyGateProblems,
  LINT_STAGED_CONFIG_PATH,
  lintStagedCommands,
  orderingProblems,
  purityProblems,
  readRepoFile,
  TIMING_WRAPPER_PATH,
  timingWrapperProblems,
} from "./local-quality-invariants.mjs";

describe("local quality: check registry", () => {
  it("covers the six config checks with tracked source files", () => {
    expect(CHECK_AREAS.map((area) => area.id)).toEqual([
      "workspace-metadata",
      "devcontainer-metadata",
      "dependabot-shape",
      "naming-doc-coherence",
      "release-age-policy",
      "hook-wiring",
    ]);
    for (const file of checkFiles()) {
      expect(readRepoFile(file), `${file} is missing`).not.toBeNull();
    }
  });
});

describe("local quality: purity and determinism (VAL-LOCAL-021)", () => {
  it("no check source performs network, write, clock, or timer operations", () => {
    for (const file of checkFiles()) {
      expect(purityProblems(file, readRepoFile(file))).toEqual([]);
    }
  });

  it("enumeration order never leaks into diagnostics", () => {
    for (const file of checkFiles()) {
      expect(orderingProblems(file, readRepoFile(file))).toEqual([]);
    }
  });

  it("flags every forbidden construct in a mutated source", () => {
    const dirty = [
      'import { get } from "node:http";',
      'import { writeFileSync, mkdirSync } from "node:fs";',
      "fetch('https://example.com');",
      "server.listen(8080);",
      "socket.connect(80);",
      "writeFileSync('x', '');",
      "mkdirSync('y');",
      "Math.random();",
      "Date.now();",
      "new Date();",
      "performance.now();",
      "spawn('a');",
      "exec('b');",
      "fork('c');",
      "setTimeout(() => {}, 1);",
    ].join("\n");
    const problems = purityProblems("fixture", dirty);
    expect(problems.length).toBeGreaterThanOrEqual(13);
    expect(purityProblems("fixture", "regexp.exec(text);\n")).toEqual([]);
    expect(
      purityProblems("fixture", "spawnSync('git', ['status']);\n")
    ).toEqual([]);
  });

  it("flags unsorted directory iteration and non-git subprocesses", () => {
    expect(orderingProblems("fixture", "readdirSync('docs');\n")).not.toEqual(
      []
    );
    expect(
      orderingProblems("fixture", "readdirSync('docs').sort();\n")
    ).toEqual([]);
    expect(
      orderingProblems("fixture", 'spawnSync("git", ["ls-files"]);\n')
    ).toEqual([]);
    expect(
      orderingProblems("fixture", 'spawnSync("curl", ["-sI", "x"]);\n')
    ).not.toEqual([]);
  });
});

describe("local quality: fast-gate scope (VAL-LOCAL-024)", () => {
  it("the hook and lint-staged commands never run heavy gates", () => {
    const hook = readRepoFile(HOOK_PATH) ?? "";
    expect(heavyGateProblems("hook", hook)).toEqual([]);
    const config = readRepoFile(LINT_STAGED_CONFIG_PATH) ?? "";
    for (const command of lintStagedCommands(config)) {
      expect(heavyGateProblems("lint-staged", command)).toEqual([]);
    }
  });

  it("flags heavy gates in mutated hook commands", () => {
    for (const command of [
      "pnpm test",
      "turbo run build",
      "vitest run",
      "tsc --noEmit",
      "pnpm coverage",
      "pnpm stress:runtime-storage",
      "pnpm api:check",
      "pnpm dev:tui",
      "pnpm dev:worker",
      "wrangler dev",
    ]) {
      expect(heavyGateProblems("fixture", command), command).not.toEqual([]);
    }
    expect(heavyGateProblems("fixture", "pnpm exec ultracite fix")).toEqual([]);
    expect(heavyGateProblems("fixture", "pnpm exec lint-staged")).toEqual([]);
  });

  it("documents concrete numeric bounds for every fast gate", () => {
    const doc = readRepoFile(CONTRIBUTING_PATH) ?? "";
    expect(gateBoundProblems(doc)).toEqual([]);
  });

  it("rejects missing, vague, or over-ceiling bounds", () => {
    expect(gateBoundProblems("# Contributing\n")).not.toEqual([]);
    const section = (rows) =>
      `## Fast local gates\n\n| Gate | Command | Bound |\n| --- | --- | --- |\n${rows}\n` +
      "\nAt most one devcontainer build and two lightweight validators run\n" +
      "concurrently; time gates with scripts/time-gate.mjs.\n";
    const goodRows =
      "| Pre-commit hook | lint-staged | ≤ 60 s |\n" +
      "| All invariants | vitest run | ≤ 120 s |\n" +
      "| Single invariant | vitest run one | ≤ 30 s |";
    expect(gateBoundProblems(section(goodRows))).toEqual([]);
    expect(
      gateBoundProblems(
        section(goodRows.replace("≤ 60 s", "≤ 90 s")).replace(
          "Pre-commit",
          "Pre-commit"
        )
      ).join("\n")
    ).toContain("60s ceiling");
    expect(
      gateBoundProblems(
        section(goodRows.replace("| ≤ 120 s |", "| fast |"))
      ).join("\n")
    ).toContain("lacks a concrete numeric bound");
    expect(
      gateBoundProblems(
        section(goodRows.replace("Pre-commit hook", "Lint staged files"))
      ).join("\n")
    ).toContain("pre-commit");
    expect(
      gateBoundProblems(
        section(goodRows).replace(
          "one devcontainer build",
          "a devcontainer build"
        )
      ).join("\n")
    ).toContain("devcontainer");
  });
});

describe("local quality: CI wiring (VAL-LOCAL-023)", () => {
  it("ci.yml runs the same checks on Node 24 and 26 under network isolation", () => {
    const workflow = readRepoFile(CI_WORKFLOW_PATH) ?? "";
    expect(ciWiringProblems(workflow)).toEqual([]);
  });

  it("rejects a matrix without Node 24/26 and a test step without isolation", () => {
    const workflow = `
jobs:
  checks:
    strategy:
      matrix:
        node: ["24"]
    steps:
      - run: pnpm test
`;
    const problems = ciWiringProblems(workflow).join("\n");
    expect(problems).toContain("Node 26");
    expect(problems).toContain("PSS_TASK_VALIDATOR_NETWORK_ISOLATED");
    const noTestStep = `
jobs:
  checks:
    strategy:
      matrix:
        node: ["24", "26"]
    steps:
      - run: pnpm lint
`;
    expect(ciWiringProblems(noTestStep).join("\n")).toContain("pnpm test");
  });
});

describe("local quality: timing wrapper (VAL-LOCAL-024)", () => {
  it("scripts/time-gate.mjs implements the bounded-kill contract", () => {
    const source = readRepoFile(TIMING_WRAPPER_PATH);
    expect(source, `${TIMING_WRAPPER_PATH} is missing`).not.toBeNull();
    expect(timingWrapperProblems(source)).toEqual([]);
  });

  it("rejects a wrapper that cannot kill the process group", () => {
    const weak = "spawn(cmd); // no detached, no group kill\n";
    expect(timingWrapperProblems(weak)).not.toEqual([]);
  });
});
