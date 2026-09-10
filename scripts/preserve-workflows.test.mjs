import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  evalCarveoutProblems,
  GITIGNORE_PATH,
  ignoreProblems,
  NPMIGNORE_PATH,
  PACKAGE_JSON_PATH,
  parsePatterns,
  REQUIRED_GITIGNORE_PATTERNS,
  REQUIRED_NPMIGNORE_PATTERNS,
  readRepoFile,
  reportPatternProblems,
  scriptProblems,
  WORKFLOW_PATHS,
} from "./preserve-workflows.mjs";

const REPORT_LINE = /^report\/?$/;

function checkIgnoreStatus(pathname) {
  return spawnSync("git", ["check-ignore", "-q", "--", pathname], {
    encoding: "utf8",
  }).status;
}

function gitTracked(pathname) {
  const result = spawnSync("git", ["ls-files", "--", pathname], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() !== "";
}

function rootScripts() {
  return JSON.parse(readRepoFile(PACKAGE_JSON_PATH)).scripts ?? {};
}

function committedWorkflows() {
  return WORKFLOW_PATHS.map((path) => ({ path, source: readRepoFile(path) }));
}

describe("workflow preservation: ignore rules (VAL-LOCAL-027)", () => {
  it("keeps the complete pre-mission .gitignore rule set", () => {
    const source = readRepoFile(GITIGNORE_PATH);
    expect(
      ignoreProblems(GITIGNORE_PATH, source, REQUIRED_GITIGNORE_PATTERNS)
    ).toEqual([]);
  });

  it("keeps the complete pre-mission .npmignore rule set", () => {
    const source = readRepoFile(NPMIGNORE_PATH);
    expect(
      ignoreProblems(NPMIGNORE_PATH, source, REQUIRED_NPMIGNORE_PATTERNS)
    ).toEqual([]);
  });

  it("adds the report pattern for analysis artifacts", () => {
    expect(reportPatternProblems(readRepoFile(GITIGNORE_PATH))).toEqual([]);
  });

  it("flags a removed pattern even when a broader pattern covers it", () => {
    const baseline = parsePatterns(readRepoFile(GITIGNORE_PATH));
    const mutated = baseline
      .filter((pattern) => pattern !== "dist")
      .concat("d*");
    const problems = ignoreProblems(
      GITIGNORE_PATH,
      mutated.join("\n"),
      REQUIRED_GITIGNORE_PATTERNS
    ).join("\n");
    expect(problems).toContain('"dist"');
  });

  it("flags a silently rewritten pattern", () => {
    const problems = ignoreProblems(
      NPMIGNORE_PATH,
      REQUIRED_NPMIGNORE_PATTERNS.map((pattern) =>
        pattern === "node_modules/" ? "node_modules" : pattern
      ).join("\n"),
      REQUIRED_NPMIGNORE_PATTERNS
    ).join("\n");
    expect(problems).toContain('"node_modules/"');
  });

  it("flags a missing report pattern", () => {
    const source = readRepoFile(GITIGNORE_PATH)
      .split("\n")
      .filter((line) => !REPORT_LINE.test(line.trim()))
      .join("\n");
    expect(reportPatternProblems(source)).not.toEqual([]);
  });
});

describe("workflow preservation: git ignore resolution (VAL-LOCAL-027/030)", () => {
  it("resolves representative generated artifacts as ignored", () => {
    const ignored = [
      "node_modules",
      "dist",
      "coverage/lcov.info",
      ".turbo",
      ".artifacts/nextjs-bench",
      "packages/runtime/.turbo",
      ".wrangler/state",
      ".omo/evidence/local-preserve-workflows/out.log",
      ".senpi/session",
      "report/knip.json",
      ".env.local",
      ".dev.vars",
    ];
    for (const pathname of ignored) {
      expect(checkIgnoreStatus(pathname), pathname).toBe(0);
    }
  });

  it("keeps shared plans and sources out of the ignore set", () => {
    for (const pathname of [
      ".omo/plans/notes.md",
      "packages/runtime/src/index.ts",
    ]) {
      expect(checkIgnoreStatus(pathname), pathname).toBe(1);
    }
  });

  it("keeps the root AGENTS.md tracked despite its ignore pattern", () => {
    // git check-ignore never reports tracked paths, so the pinned pattern
    // presence (rule-set test above) plus the tracked listing is the proof.
    expect(parsePatterns(readRepoFile(GITIGNORE_PATH))).toContain("AGENTS.md");
    expect(gitTracked("AGENTS.md")).toBe(true);
  });
});

describe("workflow preservation: root scripts (VAL-LOCAL-028)", () => {
  it("retains every pre-existing root script key", () => {
    expect(scriptProblems(rootScripts())).toEqual([]);
  });

  it("flags a removed or renamed pre-existing script", () => {
    const renamed = Object.fromEntries(
      Object.entries(rootScripts()).map(([key, value]) => [
        key === "lint" ? "lint:all" : key,
        value,
      ])
    );
    expect(scriptProblems(renamed).join("\n")).toContain('"lint"');
    const removed = Object.fromEntries(
      Object.entries(rootScripts()).filter(([key]) => key !== "verify:release")
    );
    expect(scriptProblems(removed).join("\n")).toContain('"verify:release"');
  });

  it("gates credentialed eval scripts behind the CI secret-gate only", () => {
    expect(evalCarveoutProblems(committedWorkflows())).toEqual([]);
  });

  it("flags a credentialed eval outside the secret-gated jobs", () => {
    const ungated = {
      path: ".github/workflows/ci.yml",
      source: "jobs:\n  checks:\n    steps:\n      - run: pnpm eval:provider\n",
    };
    expect(
      evalCarveoutProblems([...committedWorkflows(), ungated]).join("\n")
    ).toContain("secret-gate");
  });

  it("flags a gated job that drops the secret-gate dependency", () => {
    const dropped = committedWorkflows().map((workflow) =>
      workflow.path.endsWith("extended-verification.yml")
        ? {
            ...workflow,
            source: workflow.source.replace(
              "live-provider:\n    needs: secret-gate",
              "live-provider:"
            ),
          }
        : workflow
    );
    expect(evalCarveoutProblems(dropped).join("\n")).toContain(
      'job "live-provider"'
    );
  });
});
