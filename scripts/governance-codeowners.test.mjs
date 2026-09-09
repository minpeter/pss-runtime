import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  coversArea,
  coversTopLevelDir,
  findDuplicatePatterns,
  findEnforcementClaims,
  findOwnershipDrift,
  parseCodeowners,
  REQUIRED_DIR_AREAS,
  topLevelSourceDirs,
} from "./governance-codeowners.mjs";

const CODEOWNERS_PATH = ".github/CODEOWNERS";
const ENFORCEMENT_SCAN_FILES = [
  CODEOWNERS_PATH,
  "CONTRIBUTING.md",
  "README.md",
];
const GOVERNANCE_DOCS = ["AGENTS.md", "CONTRIBUTING.md", "README.md"];

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function readCodeowners() {
  return readFileSync(CODEOWNERS_PATH, "utf8");
}

function runbookFiles() {
  const listing = spawnSync("git", ["ls-files", "docs/runbooks"], {
    encoding: "utf8",
  });
  if (listing.status !== 0) {
    return [];
  }
  return listing.stdout.split("\n").filter((path) => path.endsWith(".md"));
}

// Writes synthetic content to a temp file so the classifiers can be exercised
// on negative cases without mutating any tracked file. Uses a repo-local base
// (not the OS tmpdir) so it stays inside the gitignored workspace.
const FIXTURE_BASE = ".omo/tmp";

function fixtureDir() {
  mkdirSync(FIXTURE_BASE, { recursive: true });
  const dir = mkdtempSync(join(FIXTURE_BASE, "gov-codeowners-"));
  tempDirs.push(dir);
  return dir;
}

function withFixture(text) {
  const file = join(fixtureDir(), "fixture.md");
  writeFileSync(file, `${text}\n`);
  return file;
}

describe("governance: CODEOWNERS", () => {
  it("exists, is git-tracked, and is non-empty (VAL-GOV-001)", () => {
    const tracked = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", CODEOWNERS_PATH],
      { encoding: "utf8" }
    );
    expect(tracked.status, tracked.stderr).toBe(0);
    expect(readCodeowners().trim().length).toBeGreaterThan(0);
  });

  it("lines are valid ownership entries with @-prefixed owners (VAL-GOV-002)", () => {
    const { entries, errors } = parseCodeowners(readCodeowners());
    expect(errors).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("rejects email-shaped, owner-less, and double-@ lines (VAL-GOV-002)", () => {
    expect(parseCodeowners("* user@example.com").errors).not.toEqual([]);
    expect(parseCodeowners("* @user@example.com").errors).not.toEqual([]);
    expect(parseCodeowners("/docs/ owner").errors).not.toEqual([]);
    expect(parseCodeowners("/docs/").errors).not.toEqual([]);
    expect(parseCodeowners("* @minpeter").errors).toEqual([]);
    expect(parseCodeowners("/pkg/ @org/team").errors).toEqual([]);
    expect(parseCodeowners("/pkg/ @org/*").errors).toEqual([]);
  });

  it("covers root and every required repository area (VAL-GOV-003)", () => {
    const { entries } = parseCodeowners(readCodeowners());
    expect(coversArea(entries, "*")).toBe(true);
    for (const area of REQUIRED_DIR_AREAS) {
      expect(coversArea(entries, area), `missing ownership for ${area}`).toBe(
        true
      );
    }
  });

  it("owns every real top-level source directory (VAL-GOV-003)", () => {
    const { entries } = parseCodeowners(readCodeowners());
    for (const dir of topLevelSourceDirs()) {
      expect(coversTopLevelDir(entries, dir), `unowned area ${dir}`).toBe(true);
    }
  });

  it("ignores generated directories added between Test and test:timing (VAL-GOV-003)", () => {
    const root = fixtureDir();
    for (const dir of [".github", "packages/runtime", "scripts"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    const before = topLevelSourceDirs(root).sort();
    expect(before).toEqual([".github", "packages", "scripts"]);
    for (const file of [
      "coverage/core/coverage-summary.json",
      "dist/index.js",
      "report/test-timing.json",
      "node_modules/example/index.js",
      ".omo/tmp/raw.json",
    ]) {
      const path = join(root, file);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "{}");
    }
    expect(topLevelSourceDirs(root).sort()).toEqual(before);
  });

  it("flags new top-level source areas even beside generated directories (VAL-GOV-003)", () => {
    const root = fixtureDir();
    const unowned = [
      "brand-new-area",
      "coverage-tools",
      "distribution",
      "reports",
    ];
    for (const dir of ["coverage/core", "report", ...unowned]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    const dirs = topLevelSourceDirs(root);
    const { entries } = parseCodeowners(readCodeowners());
    for (const dir of unowned) {
      expect(dirs).toContain(dir);
      expect(coversTopLevelDir(entries, dir)).toBe(false);
      expect(coversArea(entries, dir)).toBe(false);
    }
  });

  it("contains no duplicate pattern blocks (VAL-GOV-004)", () => {
    const { entries } = parseCodeowners(readCodeowners());
    expect(findDuplicatePatterns(entries)).toEqual([]);
  });

  it("detects a duplicated pattern line (VAL-GOV-004)", () => {
    const { entries } = parseCodeowners("/docs/ @a\n/docs/ @b\n");
    expect(findDuplicatePatterns(entries)).toContain("docs");
  });

  it("makes no ownership-enforcement claim in governance files (VAL-GOV-005)", () => {
    const files = [...ENFORCEMENT_SCAN_FILES, ...runbookFiles()];
    expect(findEnforcementClaims(files)).toEqual([]);
  });

  it("fails on an introduced enforcement claim but allows advisory/coverage text (VAL-GOV-005)", () => {
    expect(
      findEnforcementClaims([
        withFixture("ownership is enforced by branch protection"),
      ])
    ).not.toEqual([]);
    expect(
      findEnforcementClaims([
        withFixture("required reviewers approve every merge"),
      ])
    ).not.toEqual([]);
    expect(
      findEnforcementClaims([
        withFixture(
          "Ownership is advisory only; enforced approvals are deferred."
        ),
      ])
    ).toEqual([]);
    expect(
      findEnforcementClaims([
        withFixture("run pnpm coverage to enforce separate package baselines"),
      ])
    ).toEqual([]);
  });

  it("governance docs never restate a divergent owner list (VAL-GOV-006)", () => {
    const { entries } = parseCodeowners(readCodeowners());
    const docs = [...GOVERNANCE_DOCS, ...runbookFiles()];
    expect(findOwnershipDrift(entries, docs)).toEqual([]);
  });

  it("detects a restated owner list that disagrees with CODEOWNERS (VAL-GOV-006)", () => {
    const { entries } = parseCodeowners("/docs/ @minpeter\n");
    expect(
      findOwnershipDrift(entries, [withFixture("/docs/ @someone-else")])
    ).not.toEqual([]);
  });

  it("flags a doc that mentions CODEOWNERS without the canonical path (VAL-GOV-006)", () => {
    const { entries } = parseCodeowners("* @minpeter\n");
    expect(
      findOwnershipDrift(entries, [withFixture("See CODEOWNERS for owners.")])
    ).not.toEqual([]);
    expect(
      findOwnershipDrift(entries, [
        withFixture("See .github/CODEOWNERS for owners."),
      ])
    ).toEqual([]);
  });
});
