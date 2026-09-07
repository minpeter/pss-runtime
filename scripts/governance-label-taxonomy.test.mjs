import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const PRIORITY_HEADING = /^## Priority$/m;

import {
  allEntries,
  collectLabelReferences,
  completionClaims,
  duplicateNames,
  entryErrors,
  invalidEntries,
  isReferenced,
  issueFormLabels,
  missingCategories,
  parseSections,
  REQUIRED_CATEGORIES,
  statesRemoteDeferral,
  TAXONOMY_PATH,
  taxonomyLinkResolves,
  taxonomyNames,
  unknownReferences,
} from "./governance-label-taxonomy.mjs";

function taxonomy() {
  return readTaxonomy();
}

function readTaxonomy() {
  return spawnSync("cat", [TAXONOMY_PATH], { encoding: "utf8" }).stdout;
}

describe("governance: label taxonomy", () => {
  it("exists, is git-tracked, non-empty, and referenced (VAL-GOV-019)", () => {
    const tracked = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", TAXONOMY_PATH],
      { encoding: "utf8" }
    );
    expect(tracked.status, tracked.stderr).toBe(0);
    expect(taxonomy().trim().length).toBeGreaterThan(0);
    expect(isReferenced()).toBe(true);
  });

  it("fails link resolution for a stale taxonomy reference (VAL-GOV-019)", () => {
    // taxonomyLinkResolves is false when no doc links the file; prove the
    // resolver rejects a link target that does not exist on disk.
    expect(taxonomyLinkResolves("does-not-exist.md")).toBe(false);
  });

  it("defines type, priority, and area as populated sections (VAL-GOV-020)", () => {
    const sections = parseSections(taxonomy());
    expect(missingCategories(sections)).toEqual([]);
    for (const category of REQUIRED_CATEGORIES) {
      const owned = sections.filter((s) => s.category === category);
      expect(
        owned.some((s) => s.entries.length > 0),
        category
      ).toBe(true);
    }
  });

  it("fails when a required category is removed (VAL-GOV-020)", () => {
    const withoutPriority = taxonomy().replace(PRIORITY_HEADING, "## Cadence");
    expect(missingCategories(parseSections(withoutPriority))).toContain(
      "priority"
    );
  });

  it("gives every entry a name, valid hex color, and purpose (VAL-GOV-021)", () => {
    expect(invalidEntries(parseSections(taxonomy()))).toEqual([]);
  });

  it("rejects malformed color, empty purpose, and missing name (VAL-GOV-021)", () => {
    expect(entryErrors({ name: "x", color: "blue", purpose: "p" })).toContain(
      'invalid color "blue"'
    );
    expect(entryErrors({ name: "x", color: "#12", purpose: "p" })).not.toEqual(
      []
    );
    expect(entryErrors({ name: "x", color: "#abc", purpose: "" })).toContain(
      "empty purpose"
    );
    expect(entryErrors({ name: "", color: "#aabbcc", purpose: "p" })).toContain(
      "missing name"
    );
    // Valid 3- and 6-digit hex pass.
    expect(entryErrors({ name: "x", color: "#0e8a16", purpose: "p" })).toEqual(
      []
    );
    expect(entryErrors({ name: "y", color: "#abc", purpose: "p" })).toEqual([]);
  });

  it("keeps every taxonomy label name unique (VAL-GOV-021/022)", () => {
    expect(duplicateNames(allEntries(parseSections(taxonomy())))).toEqual([]);
  });

  it("detects a duplicated taxonomy name (VAL-GOV-022)", () => {
    const dupped = [
      { name: "type: bug" },
      { name: "type: bug" },
      { name: "area: docs" },
    ];
    expect(duplicateNames(dupped)).toEqual(["type: bug"]);
  });

  it("resolves every label reference against the taxonomy (VAL-GOV-022)", () => {
    const names = taxonomyNames(taxonomy());
    const refs = collectLabelReferences();
    // Issue forms declare at least one label reference (the type labels).
    expect(issueFormLabels().length).toBeGreaterThan(0);
    expect(unknownReferences(refs, names)).toEqual([]);
  });

  it("fails when a form references an undefined label (VAL-GOV-022)", () => {
    const names = taxonomyNames(taxonomy());
    const refs = [
      { source: ".github/ISSUE_TEMPLATE/bug.yml", label: "type: bug" },
      { source: ".github/ISSUE_TEMPLATE/bug.yml", label: "type: phantom" },
    ];
    expect(unknownReferences(refs, names).map((r) => r.label)).toEqual([
      "type: phantom",
    ]);
  });

  it("never claims remote labels were created (VAL-GOV-023)", () => {
    const text = taxonomy();
    expect(completionClaims(text)).toEqual([]);
    expect(statesRemoteDeferral(text)).toBe(true);
  });

  it("flags a remote-creation completion claim (VAL-GOV-023)", () => {
    const bad = "The labels were created on GitHub and are now active.";
    expect(completionClaims(bad).length).toBeGreaterThan(0);
    // A deferral marker on the same line is allowed.
    const ok = "Label creation on GitHub is deferred and external.";
    expect(completionClaims(ok)).toEqual([]);
  });
});
