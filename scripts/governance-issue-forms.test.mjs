import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  bodyElementErrors,
  classifyForm,
  collectFormText,
  findCredentialSolicitation,
  findDanglingPaths,
  frontmatterErrors,
  hasFieldMatching,
  ISSUE_TEMPLATE_DIR,
  listFormFiles,
  parseForm,
} from "./governance-issue-forms.mjs";

const REPRO_LABEL = /repro|step/i;
const ENVIRONMENT_LABEL = /environment|version|node|pnpm/i;
const EXPECTED_LABEL = /feature|expected|behavior/i;
const IMPACT_LABEL = /impact|use case/i;
const ACCEPTANCE_LABEL = /acceptance|criteria/i;

function trackedFormFiles() {
  const listing = spawnSync("git", ["ls-files", ISSUE_TEMPLATE_DIR], {
    encoding: "utf8",
  });
  expect(listing.status, listing.stderr).toBe(0);
  return listForms(listing.stdout);
}

function listForms(stdout) {
  return listFormFiles(stdout);
}

function loadForms() {
  return trackedFormFiles().map((path) => ({ path, form: parseForm(path) }));
}

function bugForm() {
  return loadForms().find(({ form }) => classifyForm(form).isBug)?.form;
}

function featureForm() {
  return loadForms().find(({ form }) => classifyForm(form).isFeature)?.form;
}

describe("governance: issue forms", () => {
  it("has a tracked bug and feature form that parse (VAL-GOV-007)", () => {
    const forms = loadForms();
    expect(forms.length).toBeGreaterThanOrEqual(2);
    expect(forms.some(({ form }) => classifyForm(form).isBug)).toBe(true);
    expect(forms.some(({ form }) => classifyForm(form).isFeature)).toBe(true);
    for (const { form } of forms) {
      expect(typeof form).toBe("object");
    }
  });

  it("requires name, description, and a non-empty body array (VAL-GOV-008)", () => {
    for (const { path, form } of loadForms()) {
      expect(frontmatterErrors(form), path).toEqual([]);
    }
  });

  it("fails when a required top-level key is missing (VAL-GOV-008)", () => {
    expect(frontmatterErrors({ description: "x", body: [{}] })).toContain(
      "missing or empty name"
    );
    expect(
      frontmatterErrors({ name: "x", description: "y", body: [] })
    ).toContain("body is not a non-empty array");
    expect(
      frontmatterErrors({ name: "  ", description: "y", body: [{}] })
    ).toContain("missing or empty name");
  });

  it("only uses valid GitHub form elements with unique ids (VAL-GOV-009)", () => {
    for (const { path, form } of loadForms()) {
      expect(bodyElementErrors(form), path).toEqual([]);
    }
  });

  it("rejects unknown type, missing id, missing attributes, and dup ids (VAL-GOV-009)", () => {
    expect(
      bodyElementErrors({ body: [{ type: "banana", id: "a", attributes: {} }] })
    ).not.toEqual([]);
    expect(
      bodyElementErrors({ body: [{ type: "input", attributes: {} }] })
    ).not.toEqual([]);
    expect(
      bodyElementErrors({ body: [{ type: "textarea", id: "a" }] })
    ).not.toEqual([]);
    expect(
      bodyElementErrors({
        body: [
          { type: "input", id: "dup", attributes: {} },
          { type: "textarea", id: "dup", attributes: {} },
        ],
      })
    ).not.toEqual([]);
    // A markdown intro carries no id and must remain valid.
    expect(
      bodyElementErrors({
        body: [{ type: "markdown", attributes: { value: "hi" } }],
      })
    ).toEqual([]);
  });

  it("bug form collects reproduction and environment context (VAL-GOV-010)", () => {
    const form = bugForm();
    expect(form).toBeDefined();
    expect(hasFieldMatching(form, REPRO_LABEL)).toBe(true);
    expect(hasFieldMatching(form, ENVIRONMENT_LABEL)).toBe(true);
  });

  it("fails if the reproduction field is replaced by a markdown blurb (VAL-GOV-010)", () => {
    const degraded = {
      name: "Bug report",
      description: "bug",
      body: [
        { type: "markdown", attributes: { value: "repro steps go here" } },
        {
          type: "textarea",
          id: "env",
          attributes: { label: "Environment and versions (node/pnpm)" },
        },
      ],
    };
    expect(hasFieldMatching(degraded, REPRO_LABEL)).toBe(false);
  });

  it("feature form collects expected behavior, impact, and acceptance (VAL-GOV-011)", () => {
    const form = featureForm();
    expect(form).toBeDefined();
    expect(hasFieldMatching(form, EXPECTED_LABEL)).toBe(true);
    expect(hasFieldMatching(form, IMPACT_LABEL)).toBe(true);
    expect(hasFieldMatching(form, ACCEPTANCE_LABEL)).toBe(true);
  });

  it("fails if the feature form drops the acceptance-criteria field (VAL-GOV-011)", () => {
    const degraded = {
      name: "Feature request",
      description: "feature",
      body: [
        {
          type: "textarea",
          id: "expected",
          attributes: { label: "Expected behavior" },
        },
        {
          type: "textarea",
          id: "impact",
          attributes: { label: "Use case and impact" },
        },
      ],
    };
    expect(hasFieldMatching(degraded, ACCEPTANCE_LABEL)).toBe(false);
  });

  it("never solicits credentials or references dangling paths (VAL-GOV-012)", () => {
    for (const { path, form } of loadForms()) {
      const text = collectFormText(form);
      expect(findCredentialSolicitation(text), path).toEqual([]);
      expect(findDanglingPaths(text), path).toEqual([]);
    }
  });

  it("detects credential solicitation and dangling paths in bad text (VAL-GOV-012)", () => {
    expect(
      findCredentialSolicitation("Paste your API key and .env contents here")
    ).not.toEqual([]);
    expect(findCredentialSolicitation("Paste your auth header")).not.toEqual(
      []
    );
    expect(findDanglingPaths("see packages/does-not-exist/foo.ts")).toEqual([
      "packages/does-not-exist/foo.ts",
    ]);
    expect(findDanglingPaths("see packages/runtime")).toEqual([]);
  });
});
