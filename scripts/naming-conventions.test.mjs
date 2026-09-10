import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  coherenceViolations,
  DOC_PATH,
  effectiveLinterRules,
  isRuleEnabled,
  missingSubjects,
  NAMING_RULES,
  parseDocumentedRules,
} from "./naming-conventions.mjs";

const docText = readFileSync(DOC_PATH, "utf8");
const documentedRows = parseDocumentedRules(docText);
const effectiveRules = effectiveLinterRules(".");

function syntheticDoc(rows) {
  return [
    "## Naming conventions",
    "",
    "| Subject | Convention | Status | Tooling rule |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

describe("naming conventions documentation", () => {
  it("documents a naming rule for every required subject", () => {
    expect(documentedRows.length).toBeGreaterThan(0);
    expect(missingSubjects(documentedRows)).toEqual([]);
  });

  it("gives every documented rule an enforced or advisory status", () => {
    const unclassified = documentedRows
      .filter((row) => row.status === null)
      .map((row) => row.subject);
    expect(unclassified).toEqual([]);
  });

  it("marks advisory rules with no tooling rule id", () => {
    const advisoryWithRule = documentedRows
      .filter((row) => row.status === "advisory" && row.ruleId !== null)
      .map((row) => row.subject);
    expect(advisoryWithRule).toEqual([]);
  });

  it("detects a documented subject losing its coverage", () => {
    const rows = parseDocumentedRules(
      syntheticDoc([
        "| Package names | kebab-case | Advisory | — |",
        "| Variables | camelCase | Enforced | `style/useNamingConvention` |",
      ])
    );
    expect(missingSubjects(rows)).toEqual(
      expect.arrayContaining(["file", "function", "constant", "type", "class"])
    );
  });
});

describe("naming documentation/toolchain coherence", () => {
  it("resolves every documented enforced rule to a configured rule", () => {
    expect(coherenceViolations(documentedRows, effectiveRules)).toEqual([]);
  });

  it("keeps every configured naming rule documented", () => {
    const undocumented = NAMING_RULES.filter(
      (ruleId) =>
        isRuleEnabled(effectiveRules[ruleId]) &&
        !documentedRows.some((row) => row.ruleId === ruleId)
    );
    expect(undocumented).toEqual([]);
  });

  it("fails naming a rule documented as enforced but dropped from the config", () => {
    const { "style/useNamingConvention": _dropped, ...withoutNaming } =
      effectiveRules;
    const violations = coherenceViolations(documentedRows, withoutNaming);
    expect(
      violations.some((violation) =>
        violation.includes("style/useNamingConvention")
      )
    ).toBe(true);
  });

  it("fails naming a rule set to off but still documented as enforced", () => {
    const disabled = {
      ...effectiveRules,
      "style/useFilenamingConvention": "off",
    };
    const violations = coherenceViolations(documentedRows, disabled);
    expect(
      violations.some((violation) =>
        violation.includes("style/useFilenamingConvention")
      )
    ).toBe(true);
  });

  it("fails naming a configured naming rule missing from the docs", () => {
    const rows = parseDocumentedRules(
      syntheticDoc([
        "| Variables | camelCase | Enforced | `style/useNamingConvention` |",
      ])
    );
    const violations = coherenceViolations(rows, effectiveRules);
    expect(
      violations.some((violation) =>
        violation.includes("style/useFilenamingConvention")
      )
    ).toBe(true);
  });
});
