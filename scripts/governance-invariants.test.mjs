import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  credentialHits,
  governanceScanFiles,
  hostPathHits,
  manifestDriftProblems,
  manifestProblems,
  REQUIRED_MANIFEST,
  repoCredentialHits,
  repoHostPathHits,
  rootDevDependencyNames,
  rootTestScript,
  SCAN_DIRS,
  SCAN_EXTRA_FILES,
  selfNetworkHits,
  untrackedProblems,
  yamlParsersIn,
  yamlScopeProblems,
} from "./governance-invariants.mjs";

function gitLsFiles() {
  const res = spawnSync("git", ["ls-files"], { encoding: "utf8" });
  expect(res.status, res.stderr).toBe(0);
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("governance: validator is part of pnpm test and stays scoped (VAL-GOV-059)", () => {
  it("is collected by the root test phase via the scripts glob", () => {
    expect(rootTestScript()).toContain("vitest run scripts/*.test.mjs");
  });

  it("uses at most one lightweight YAML parser and no other YAML parser", () => {
    const devDeps = rootDevDependencyNames();
    expect(yamlScopeProblems(devDeps)).toEqual([]);
    expect(yamlParsersIn(devDeps).length).toBeLessThanOrEqual(1);
  });

  it("flags a second YAML parser as over budget", () => {
    expect(yamlScopeProblems(["yaml"])).toEqual([]);
    expect(yamlScopeProblems([])).toEqual([]);
    expect(yamlScopeProblems(["yaml", "js-yaml"])[0]).toContain(
      "more than one YAML parser"
    );
  });
});

describe("governance: required-governance-files manifest (VAL-GOV-060)", () => {
  it("holds every required governance artifact", () => {
    for (const required of [
      ".github/CODEOWNERS",
      ".github/ISSUE_TEMPLATE/bug.yml",
      ".github/ISSUE_TEMPLATE/feature.yml",
      ".github/PULL_REQUEST_TEMPLATE.md",
      "docs/label-taxonomy.md",
      "SECURITY.md",
      "docs/runbooks/README.md",
      "CONTRIBUTING.md",
      "docs/deferred-controls.md",
      "README.md",
    ]) {
      expect(REQUIRED_MANIFEST).toContain(required);
    }
    expect(
      REQUIRED_MANIFEST.some((p) => p.startsWith(".factory/skills/"))
    ).toBe(true);
  });

  it("has every manifest entry present on disk and git-tracked", () => {
    expect(manifestProblems(REQUIRED_MANIFEST)).toEqual([]);
    expect(untrackedProblems(REQUIRED_MANIFEST, gitLsFiles())).toEqual([]);
  });

  it("has no drift between the manifest and the on-disk governance set", () => {
    expect(manifestDriftProblems()).toEqual([]);
  });

  it("fails when a required file is deleted or drops out of git tracking", () => {
    expect(manifestProblems([".github/CODEOWNERS"], "docs")).toEqual([
      "missing required governance file: .github/CODEOWNERS",
    ]);
    const tracked = gitLsFiles().filter((f) => f !== ".github/CODEOWNERS");
    expect(untrackedProblems(REQUIRED_MANIFEST, tracked)).toEqual([
      "required governance file not git-tracked: .github/CODEOWNERS",
    ]);
  });
});

describe("governance: validation is offline and side-effect-free (VAL-GOV-061)", () => {
  it("validator module uses no network, service, or port APIs", () => {
    expect(selfNetworkHits()).toEqual([]);
  });

  it("scan configuration touches only committed governance paths", () => {
    for (const path of [...REQUIRED_MANIFEST, ...SCAN_EXTRA_FILES]) {
      expect(path.startsWith("/")).toBe(false);
    }
    expect(SCAN_DIRS).toEqual([
      ".github/ISSUE_TEMPLATE",
      "docs/runbooks",
      ".factory/skills",
    ]);
    expect(governanceScanFiles().length).toBeGreaterThanOrEqual(
      REQUIRED_MANIFEST.length
    );
  });
});

describe("governance: files are credential-free (VAL-GOV-062)", () => {
  it("finds zero credential-shaped literals across the governance set", () => {
    expect(repoCredentialHits()).toEqual([]);
  });

  it("flags every credential shape in fixture text", () => {
    // Every credential-shaped fixture value is assembled from fragments at
    // runtime so no scanner (including push-time secret scanning) ever sees
    // a full token literal in this file, while the runtime-built lines still
    // match every CREDENTIAL_PATTERNS kind exactly once.
    const npmTokenName = ["NPM", "TOKEN"].join("_");
    const fixture = [
      `${npmTokenName}=abc123`,
      `key: sk-${"a".repeat(16)}`,
      `token ghp_${"a".repeat(24)}`,
      `pat github_pat_${"1A".repeat(12)}`,
      `jwt ${[`eyJ${"a".repeat(9)}`, "b".repeat(9), "c".repeat(6)].join(".")}`,
      `bot 123456789:${"A".repeat(30)}`,
      `slack xoxb-${"a".repeat(12)}`,
      `export AI_API_KEY="${"s".repeat(15)}"`,
    ].join("\n");
    const hits = credentialHits(fixture);
    expect(hits).toHaveLength(8);
  });

  it("allows documented placeholder secret names without values", () => {
    const placeholders = [
      "Set the TELEGRAM_BOT_TOKEN secret in the repository settings.",
      "`WORKER_AGENT_TUI_TOKEN` is a placeholder name, never a real value.",
      "export PSS_THREAD_DIR=", // no credential-shaped value
    ].join("\n");
    expect(credentialHits(placeholders)).toEqual([]);
  });
});

describe("governance: docs are portable and host-independent (VAL-GOV-063)", () => {
  it("finds zero absolute host paths across the governance set", () => {
    expect(repoHostPathHits()).toEqual([]);
  });

  it("flags captured host paths and allows repo-relative paths", () => {
    expect(hostPathHits("clone into /home/alice/pss-runtime")).toHaveLength(1);
    expect(hostPathHits("see /Users/bob/repo and /mnt/data/x")).toHaveLength(1);
    expect(
      hostPathHits("run from packages/runtime or docs/runbooks/README.md")
    ).toEqual([]);
  });
});
