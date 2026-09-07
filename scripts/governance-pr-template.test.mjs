import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  CONTRIBUTING_PATH,
  citedTemplatePaths,
  findUnsafeInstructions,
  hasSection,
  hasSubheading,
  hasVerificationSection,
  PR_TEMPLATE_PATH,
  readFile,
  referencesBothPackages,
  referencesPatchDefault,
  referencesTegamiCommand,
  referencesTegamiEntry,
  rootScripts,
  templateReferenceResolves,
} from "./governance-pr-template.mjs";

const SUMMARY_LABEL = /summary|what changed|overview/;
const TRADEOFF_LABEL = /trade-?off/;

function template() {
  return readFile(PR_TEMPLATE_PATH);
}

function contributing() {
  return readFile(CONTRIBUTING_PATH);
}

describe("governance: pull request template", () => {
  it("exists, is git-tracked, non-empty, and has a ## heading (VAL-GOV-013)", () => {
    const tracked = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", PR_TEMPLATE_PATH],
      { encoding: "utf8" }
    );
    expect(tracked.status, tracked.stderr).toBe(0);
    const text = template();
    expect(text.trim().length).toBeGreaterThan(0);
    expect(hasSubheading(text)).toBe(true);
  });

  it("detects the absence of a ## heading (VAL-GOV-013)", () => {
    expect(hasSubheading("plain body with no heading")).toBe(false);
    expect(hasSubheading("# Title only\n\nbody")).toBe(false);
    expect(hasSubheading("## Summary\n\nbody")).toBe(true);
  });

  it("carries summary, verification, and trade-off sections (VAL-GOV-016)", () => {
    const text = template();
    expect(hasSection(text, SUMMARY_LABEL)).toBe(true);
    expect(hasVerificationSection(text)).toBe(true);
    expect(hasSection(text, TRADEOFF_LABEL)).toBe(true);
  });

  it("fails when the verification/evidence section is removed (VAL-GOV-016)", () => {
    const withoutVerification = [
      "## Summary",
      "what changed",
      "## Trade-offs",
      "risks",
    ].join("\n");
    expect(hasVerificationSection(withoutVerification)).toBe(false);
    // A verification heading without the evidence location is insufficient.
    expect(hasVerificationSection("## Verification\n- ran tests")).toBe(false);
    expect(
      hasVerificationSection("## Verification\n- evidence: `.omo/evidence/x/`")
    ).toBe(true);
  });

  it("enforces the Tegami release-note step (VAL-GOV-017)", () => {
    const text = template();
    expect(referencesTegamiEntry(text)).toBe(true);
    expect(referencesBothPackages(text)).toBe(true);
    expect(referencesPatchDefault(text)).toBe(true);
    expect(referencesTegamiCommand(text)).toBe(true);
  });

  it("references a check:tegami-notes script that exists in root package.json (VAL-GOV-017)", () => {
    expect(typeof rootScripts()["check:tegami-notes"]).toBe("string");
    expect(rootScripts()["check:tegami-notes"].length).toBeGreaterThan(0);
  });

  it("never instructs unsafe or external actions (VAL-GOV-018)", () => {
    expect(findUnsafeInstructions(template())).toEqual([]);
  });

  it("detects planted unsafe instructions (VAL-GOV-018)", () => {
    expect(findUnsafeInstructions("run npm publish before merge")).not.toEqual(
      []
    );
    expect(findUnsafeInstructions("pnpm publish the package")).not.toEqual([]);
    expect(findUnsafeInstructions("export NPM_TOKEN=...")).not.toEqual([]);
    expect(findUnsafeInstructions("push directly to main")).not.toEqual([]);
    expect(findUnsafeInstructions("add [skip ci] to bypass")).not.toEqual([]);
    expect(findUnsafeInstructions("commit with --no-verify")).not.toEqual([]);
  });

  it("is linked from CONTRIBUTING with a resolving reference (VAL-GOV-014)", () => {
    const cited = citedTemplatePaths(contributing());
    expect(cited.length).toBeGreaterThan(0);
    for (const target of cited) {
      expect(templateReferenceResolves(target), target).toBe(true);
    }
  });

  it("fails the link check on a stale template reference (VAL-GOV-014)", () => {
    expect(
      citedTemplatePaths("see the [template](.github/PULL_REQUEST_TEMPLATE.md)")
    ).toEqual([".github/PULL_REQUEST_TEMPLATE.md"]);
    expect(
      templateReferenceResolves(".github/PULL_REQUEST_TEMPLATE_MISSING.md")
    ).toBe(false);
  });
});
