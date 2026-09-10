import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  CONTRIBUTING_PATH,
  extractCitedPaths,
  hasHeading,
  hasInvalidSyntax,
  invalidSyntaxPaths,
  isExempt,
  missingSections,
  readContributing,
  unresolvedCitedPaths,
} from "./governance-contributing.mjs";

const ANY_HEADING_TEXT = /\S/;
const EVIDENCE_MANDATE = /\.omo\/evidence\//;
const ATOMIC = /atomic/i;
const CONVENTIONAL_COMMITS = /Conventional Commits/;
const MAIN_BRANCH = /\bmain\b/;
const SKIP_TOKEN = /\.skip/;
const INFERENCE = /inference/i;
const PORT = /port/i;
const NEVER_HEADING_LINE = /^## Never$/m;
const QA_HEADING_LINE = /^## QA discipline$/m;
const EVIDENCE_PATH_GLOBAL = /\.omo\/evidence\//g;

function contributing() {
  return readContributing();
}

describe("governance: CONTRIBUTING structure (VAL-GOV-015)", () => {
  it("exists, is git-tracked, non-empty, and has a heading", () => {
    const tracked = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", CONTRIBUTING_PATH],
      { encoding: "utf8" }
    );
    expect(tracked.status, tracked.stderr).toBe(0);
    const text = contributing();
    expect(text.trim().length).toBeGreaterThan(0);
    expect(hasHeading(text, ANY_HEADING_TEXT)).toBe(true);
  });

  it("parses all four required sections on the shipped file", () => {
    expect(missingSections(contributing())).toEqual([]);
  });

  it("carries the mandated content in each required section", () => {
    const text = contributing();
    // (a) real-surface QA + evidence recorded under .omo/evidence/.
    expect(text).toMatch(EVIDENCE_MANDATE);
    // (b) atomic green commits, Conventional Commits, no push to main, PR body.
    expect(text).toMatch(ATOMIC);
    expect(text).toMatch(CONVENTIONAL_COMMITS);
    expect(text).toMatch(MAIN_BRANCH);
    // (c) the "never" list: no .skip, no suppressed failures, no inference.
    expect(text).toMatch(SKIP_TOKEN);
    expect(text).toMatch(INFERENCE);
    // (d) cleanup of spawned processes/ports/temp dirs.
    expect(text).toMatch(PORT);
  });

  it("fails when the 'Never' list is removed", () => {
    const withoutNever = contributing().replace(NEVER_HEADING_LINE, "## Notes");
    expect(missingSections(withoutNever)).toContain('the "Never" list');
  });

  it("fails when the QA/evidence discipline section is removed", () => {
    const withoutQa = contributing()
      .replace(QA_HEADING_LINE, "## Notes")
      .replace(EVIDENCE_PATH_GLOBAL, ".build/output/");
    expect(missingSections(withoutQa)).toContain("QA/evidence discipline");
  });

  it("resolves every non-exempt repo-relative path it cites", () => {
    expect(unresolvedCitedPaths(contributing())).toEqual([]);
  });

  it("fails on a stale reference to a tracked path", () => {
    const stale = "See `apps/coding-agent/src/does-not-exist.ts` for details.";
    expect(unresolvedCitedPaths(stale)).toContain(
      "apps/coding-agent/src/does-not-exist.ts"
    );
  });

  it("does not fail on an absent gitignored .omo/.senpi artifact path", () => {
    const doc = [
      "Write receipts to `.omo/evidence/20990101-x/out.txt`.",
      "Stash scratch under `.senpi/tmp/scratch.json`.",
    ].join("\n");
    expect(isExempt(".omo/evidence/20990101-x/out.txt")).toBe(true);
    expect(isExempt(".senpi/tmp/scratch.json")).toBe(true);
    expect(unresolvedCitedPaths(doc)).toEqual([]);
  });

  it("does not fail on an absent gitignored runtime artifact like coverage/", () => {
    const doc = "Results land in `coverage/core/coverage-summary.json`.";
    // Not under .omo/.senpi, so only the gitignore exemption keeps it green.
    expect(isExempt("coverage/core/coverage-summary.json")).toBe(false);
    expect(unresolvedCitedPaths(doc)).toEqual([]);
  });

  it("ignores glob and placeholder tokens as non-paths", () => {
    const doc =
      "Touch `apps/coding-agent/src/tui/**` and `.tegami/YYYY-MM-DD-<slug>.md`.";
    expect(extractCitedPaths(doc)).toEqual([]);
  });

  it("rejects absolute paths and parent-escaping references as invalid syntax", () => {
    expect(hasInvalidSyntax("/etc/passwd")).toBe(true);
    expect(hasInvalidSyntax("../outside/file.ts")).toBe(true);
    expect(hasInvalidSyntax("apps/coding-agent/src/cli.ts")).toBe(false);
    expect(hasInvalidSyntax(".omo/evidence/x/out.txt")).toBe(false);
    expect(invalidSyntaxPaths(contributing())).toEqual([]);
  });
});
