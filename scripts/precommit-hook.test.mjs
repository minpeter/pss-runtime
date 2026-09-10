import { describe, expect, it } from "vitest";
import {
  commandProblems,
  configProblems,
  extraHookProblems,
  forbiddenContentProblems,
  HOOK_PATH,
  hookProblems,
  ignoreProblems,
  locateConfig,
  parseConfig,
  patternProblems,
  readRepoFile,
  trackedFileMode,
  wiringProblems,
} from "./precommit-hook.mjs";
import { declaredPolicy, policyConfigProblems } from "./precommit-policy.mjs";

const CONTRIBUTING = readRepoFile("CONTRIBUTING.md") ?? "";

function committedMappings() {
  const located = locateConfig();
  if (!located) {
    return { mappings: [], errors: ["no lint-staged config found"] };
  }
  return parseConfig(located.source, located.raw);
}

describe("local quality: pre-commit hook", () => {
  it("is installed by the standard install flow (VAL-LOCAL-001)", () => {
    expect(wiringProblems()).toEqual([]);
    const hookText = readRepoFile(HOOK_PATH);
    expect(hookProblems(hookText)).toEqual([]);
    // The hook is committed executable so a fresh checkout reproduces it.
    expect(trackedFileMode(HOOK_PATH)).toBe("100755");
  });

  it("runs lint-staged and propagates lint failures (VAL-LOCAL-001/004)", () => {
    const hookText = readRepoFile(HOOK_PATH) ?? "";
    expect(hookProblems(hookText)).toEqual([]);
    expect(hookProblems("pnpm exec lint-staged || true\n")).not.toEqual([]);
    expect(hookProblems("pnpm exec lint-staged; exit 0\n")).not.toEqual([]);
    expect(hookProblems("echo hello\n")).not.toEqual([]);
  });

  it("tracks no hook other than pre-commit (VAL-LOCAL-006)", () => {
    expect(extraHookProblems()).toEqual([]);
  });

  it("keeps husky internals untracked and ignored (VAL-LOCAL-006)", () => {
    expect(ignoreProblems()).toEqual([]);
  });

  it("config exists, parses, and is scoped to lintable types (VAL-LOCAL-003)", () => {
    const { mappings, errors } = committedMappings();
    expect(errors).toEqual([]);
    expect(configProblems(mappings)).toEqual([]);
  });

  it("rejects catch-all and non-lintable patterns (VAL-LOCAL-003)", () => {
    expect(patternProblems("*")).not.toEqual([]);
    expect(patternProblems("**/*")).not.toEqual([]);
    expect(patternProblems("src/**")).not.toEqual([]);
    expect(patternProblems("*.md")).not.toEqual([]);
    expect(patternProblems("*.{ts,png}")).not.toEqual([]);
    expect(patternProblems("*.{ts,tsx,json}")).toEqual([]);
    expect(patternProblems("**/*.css")).toEqual([]);
  });

  it("rejects index-escaping and non-allowlisted commands (VAL-LOCAL-003)", () => {
    expect(commandProblems("pnpm exec ultracite fix .")).not.toEqual([]);
    expect(commandProblems("ultracite fix && git add -u")).not.toEqual([]);
    expect(commandProblems("ultracite fix /abs/path")).not.toEqual([]);
    expect(commandProblems("eslint --fix")).not.toEqual([]);
    expect(commandProblems("pnpm exec ultracite fix")).toEqual([]);
  });

  it("declares exactly one concrete auto-fix mode (VAL-LOCAL-005)", () => {
    const { mode, problems } = declaredPolicy(CONTRIBUTING);
    expect(problems).toEqual([]);
    expect(["fix-on-write", "abort-only"]).toContain(mode);
    const { mappings } = committedMappings();
    expect(policyConfigProblems(mode, mappings)).toEqual([]);
  });

  it("rejects vacuous, dual, or missing policy wording (VAL-LOCAL-005)", () => {
    const vacuous = declaredPolicy(
      "## Pre-commit hook\n\nAuto-fix mode: if supported, the hook may rewrite files.\n"
    );
    expect(vacuous.problems).not.toEqual([]);
    const dual = declaredPolicy(
      "## Pre-commit hook\n\nAuto-fix mode: fix-on-write or abort-only.\n"
    );
    expect(dual.problems).not.toEqual([]);
    const missing = declaredPolicy("## Commits and PRs\n\nNo hook notes.\n");
    expect(missing.problems).not.toEqual([]);
    const fixMode = declaredPolicy(
      "## Pre-commit hook\n\nAuto-fix mode: fix-on-write.\n"
    );
    expect(fixMode).toEqual({ mode: "fix-on-write", problems: [] });
    const abortMode = declaredPolicy(
      "## Pre-commit hook\n\nAuto-fix mode: abort-only.\n"
    );
    expect(abortMode).toEqual({ mode: "abort-only", problems: [] });
  });

  it("policy and config agree on the fix behavior (VAL-LOCAL-005)", () => {
    const fixMappings = [
      { pattern: "*.ts", commands: ["pnpm exec ultracite fix"] },
    ];
    const checkMappings = [
      { pattern: "*.ts", commands: ["pnpm exec ultracite check"] },
    ];
    expect(policyConfigProblems("fix-on-write", fixMappings)).toEqual([]);
    expect(policyConfigProblems("fix-on-write", checkMappings)).not.toEqual([]);
    expect(policyConfigProblems("abort-only", checkMappings)).toEqual([]);
    expect(policyConfigProblems("abort-only", fixMappings)).not.toEqual([]);
  });

  it("hook artifacts carry no secrets, URLs, or network calls (VAL-LOCAL-007)", () => {
    const hookText = readRepoFile(HOOK_PATH) ?? "";
    expect(forbiddenContentProblems("hook", hookText)).toEqual([]);
    const located = locateConfig();
    expect(located).not.toBeNull();
    expect(forbiddenContentProblems("config", located.raw)).toEqual([]);
    expect(
      forbiddenContentProblems("fixture", "see https://example.com/x\n")
    ).not.toEqual([]);
    const tokenFixture = `ghp_${"A".repeat(30)}`;
    expect(forbiddenContentProblems("fixture", tokenFixture)).not.toEqual([]);
    expect(
      forbiddenContentProblems("fixture", "curl https://api.example.com")
    ).not.toEqual([]);
  });
});
