import { describe, expect, it } from "vitest";
import {
  markdownSections,
  REQUIRED_ASPECTS,
  readRunbookFiles,
  runbookEntry,
  runbookProblems,
  SECURITY_WORKFLOWS,
} from "./security-runbooks.mjs";

// Security-workflow runbook invariants (VAL-SEC-039): each security workflow
// (CodeQL, gitleaks, OWASP ZAP) has a runbook entry under docs/runbooks/
// covering trigger, expected output, failure triage, and unavailable-tool
// behavior. All checks are static over committed files and pure fixtures.

function entryFor(label) {
  const workflow = SECURITY_WORKFLOWS.find((w) => w.label === label);
  return runbookEntry(readRunbookFiles(), workflow.tool);
}

describe("runbooks: every security workflow has a complete entry (VAL-SEC-039)", () => {
  it("the shipped runbooks satisfy every aspect for every workflow", () => {
    expect(runbookProblems(readRunbookFiles())).toEqual([]);
  });

  it("covers CodeQL, gitleaks, and OWASP ZAP", () => {
    for (const label of ["CodeQL", "gitleaks", "OWASP ZAP"]) {
      expect(entryFor(label).trim(), `${label} runbook entry`).not.toBe("");
    }
  });

  it("each shipped entry documents all four required aspects", () => {
    for (const { label } of SECURITY_WORKFLOWS) {
      const entry = entryFor(label);
      for (const { key, pattern } of REQUIRED_ASPECTS) {
        expect(pattern.test(entry), `${label} entry: ${key}`).toBe(true);
      }
    }
  });
});

describe("runbooks: incomplete entries fail naming the workflow and aspect", () => {
  // A complete fixture entry for one tool; the tool name appears only in the
  // heading so entries never leak into another tool's matcher.
  const fullEntry = (tool) => `## ${tool} scan
Trigger: runs on push to main. Expected output: results print in the step
log. Triage: rotate true positives. When the tool is unavailable, the binary
is not installed locally.`;

  it("fails when no runbook entry covers a security workflow", () => {
    const problems = runbookProblems([
      { name: "unrelated.md", text: "## CI triage\nRead the run log." },
    ]);
    for (const { file, label } of SECURITY_WORKFLOWS) {
      expect(problems.some((p) => p.includes(label) && p.includes(file))).toBe(
        true
      );
    }
  });

  it("fails when an entry lacks unavailable-tool behavior", () => {
    const entry = `## gitleaks scan
Trigger: runs on push. Output: results in the step log. Triage: rotate.`;
    const problems = runbookProblems([
      { name: "codeql.md", text: fullEntry("CodeQL") },
      { name: "gitleaks.md", text: entry },
      { name: "zap.md", text: fullEntry("ZAP") },
    ]);
    expect(
      problems.some(
        (p) => p.includes("gitleaks") && p.includes("unavailable-tool behavior")
      )
    ).toBe(true);
  });

  it("fails when an entry lacks a triage path", () => {
    const entry = `## CodeQL analysis
Trigger: push to main. Output: run summary. The hosted service is external
and cannot be verified locally.`;
    const problems = runbookProblems([
      { name: "codeql.md", text: entry },
      { name: "gitleaks.md", text: fullEntry("gitleaks") },
      { name: "zap.md", text: fullEntry("ZAP") },
    ]);
    expect(
      problems.some((p) => p.includes("CodeQL") && p.includes("failure triage"))
    ).toBe(true);
  });

  it("fails when an entry lacks trigger or expected-output coverage", () => {
    const entry = `## OWASP ZAP baseline
Triage: read the results. The target host is external and unreachable by
default.`;
    const problems = runbookProblems([
      { name: "zap.md", text: entry },
      { name: "codeql.md", text: fullEntry("CodeQL") },
      { name: "gitleaks.md", text: fullEntry("gitleaks") },
    ]);
    expect(
      problems.some((p) => p.includes("OWASP ZAP") && p.includes("trigger"))
    ).toBe(true);
    expect(
      problems.some(
        (p) => p.includes("OWASP ZAP") && p.includes("expected output")
      )
    ).toBe(true);
  });
});

describe("runbooks: section splitting", () => {
  it("keeps each heading with its body", () => {
    const sections = markdownSections(
      "intro\n## One\nalpha\n### Two\nbeta\n## Three\ngamma\n"
    );
    expect(sections).toHaveLength(3);
    expect(sections[1]).toContain("### Two");
    expect(sections[1]).toContain("beta");
    expect(sections[2]).not.toContain("beta");
  });
});
