import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  citedPaths,
  inventoryProblems,
  itemSections,
  linksDeferredDoc,
  markerProblems,
  PENDING_ARTIFACTS,
  README_FILE,
  REQUIRED_FILES,
  REQUIRED_ITEMS,
  RUNBOOK_INDEX,
  readDoc,
  substituteProblems,
} from "./governance-deferred.mjs";
import {
  allWorkflowSecretIssues,
  deferredClaimHits,
  repoWideClaimHits,
  workflowSecretIssues,
} from "./governance-deferred-scan.mjs";
import { DEFERRED_DOC } from "./governance-readme.mjs";

// Builds a GitHub Actions expression string without a literal `${{` token.
const gh = (inner) => `$${"{{"} ${inner} }}`;

const ROLLBACK_SECTION = /### \d+\. Automated rollback[\s\S]*?(?=### \d+\.)/;
const BRANCH_SECTION_HEADING = /branch-protection enforcement/i;
const PENDING_NOTE = /\s*\(pending[^)]*\)/g;

const doc = readDoc(DEFERRED_DOC);

describe("governance: authoritative deferred-controls list exists (VAL-GOV-053)", () => {
  it("exists, is tracked in git, and is non-empty", () => {
    const tracked = spawnSync(
      "git",
      ["ls-files", "--error-unmatch", DEFERRED_DOC],
      { encoding: "utf8" }
    );
    expect(tracked.status, tracked.stderr).toBe(0);
    expect(doc.trim().length).toBeGreaterThan(0);
  });

  it("is linked from the runbook index and the README", () => {
    expect(linksDeferredDoc(RUNBOOK_INDEX, readDoc(RUNBOOK_INDEX))).toBe(true);
    expect(linksDeferredDoc(README_FILE, readDoc(README_FILE))).toBe(true);
  });

  it("fails the linkage check when a surface does not reference the list", () => {
    expect(linksDeferredDoc(README_FILE, "no links here")).toBe(false);
    expect(
      linksDeferredDoc(RUNBOOK_INDEX, "[x](../deferred-controls.md)")
    ).toBe(true);
    expect(
      linksDeferredDoc(README_FILE, "[x](docs/deferred-controls.md)")
    ).toBe(true);
  });
});

describe("governance: every deferred item is explicitly marked (VAL-GOV-054)", () => {
  it("contains every required item with deferred markers", () => {
    expect(inventoryProblems(doc)).toEqual([]);
    expect(markerProblems(doc)).toEqual([]);
  });

  it("fails when a required item is removed", () => {
    const stripped = doc.replace(ROLLBACK_SECTION, "");
    expect(inventoryProblems(stripped)).toContain(
      "missing deferred item: automated-rollback"
    );
  });

  it("fails when an item marker flips to complete", () => {
    const flipped = doc.replace("Status: deferred", "Status: complete");
    expect(markerProblems(flipped).length).toBeGreaterThan(0);
  });
});

describe("governance: deferred controls map to repo-local substitutes (VAL-GOV-055)", () => {
  it("cites the declared substitute artifact for every item", () => {
    expect(substituteProblems(doc)).toEqual([]);
  });

  it("tolerates only allowlisted pending artifacts, marked pending", () => {
    for (const pending of PENDING_ARTIFACTS) {
      expect(doc).toContain(pending);
    }
  });

  it("fails on an uncited substitute or a nonexistent artifact", () => {
    const section = itemSections(doc).find((s) =>
      BRANCH_SECTION_HEADING.test(s.title)
    );
    expect(section).toBeDefined();
    expect(citedPaths(section.body)).toContain(".github/CODEOWNERS");
    const uncited = doc.replaceAll("`.github/CODEOWNERS`", "CODEOWNERS");
    expect(
      substituteProblems(uncited).some((p) => p.includes("not cited"))
    ).toBe(true);
    const ghost = doc.replace("`.github/CODEOWNERS`", "`.github/GHOSTOWNERS`");
    expect(
      substituteProblems(ghost).some((p) => p.includes("does not exist"))
    ).toBe(true);
  });

  it("fails on a pending artifact without the pending marker", () => {
    const pending = PENDING_ARTIFACTS[0];
    const unmarked = doc.replaceAll(PENDING_NOTE, "");
    expect(unmarked).toContain(pending);
    expect(
      substituteProblems(unmarked).some((p) => p.includes("not marked pending"))
    ).toBe(true);
  });
});

describe("governance: no file claims a deferred control is active (VAL-GOV-056)", () => {
  it("finds zero completion claims across the scan surfaces", () => {
    expect(repoWideClaimHits()).toEqual([]);
  });

  it("flags completion claims and allows deferral wording", () => {
    expect(
      deferredClaimHits("Branch protection is enabled on the repository.")
    ).not.toEqual([]);
    expect(deferredClaimHits("gitleaks is configured")).not.toEqual([]);
    expect(
      deferredClaimHits("The CodeQL workflow is active for every pull request.")
    ).not.toEqual([]);
    expect(
      deferredClaimHits("Branch protection is deferred and external.")
    ).toEqual([]);
    expect(
      deferredClaimHits(
        "A gitleaks workflow is planned for the security milestone."
      )
    ).toEqual([]);
  });
});

describe("governance: workflows need no external settings by default (VAL-GOV-057)", () => {
  it("has no ungated secret use in any committed workflow", () => {
    expect(allWorkflowSecretIssues()).toEqual([]);
  });

  it("flags a job that uses secrets without the secret-gate", () => {
    const bad = [
      "jobs:",
      "  eval:",
      "    steps:",
      "      - run: pnpm eval:provider",
      "        env:",
      `          AI_API_KEY: ${gh("secrets.AI_API_KEY")}`,
    ].join("\n");
    expect(
      workflowSecretIssues("bad.yml", bad).some((p) => p.includes("eval"))
    ).toBe(true);
    expect(
      workflowSecretIssues("bad.yml", bad).some((p) => p.includes("skip"))
    ).toBe(true);
  });

  it("flags a secret-gate without a visible skip message", () => {
    const silent = [
      "jobs:",
      "  secret-gate:",
      "    outputs:",
      `      provider: ${gh("steps.detect.outputs.provider")}`,
      "    steps:",
      "      - id: detect",
      '        run: echo "provider=true" >> "$GITHUB_OUTPUT"',
      "        env:",
      `          AI_API_KEY: ${gh("secrets.AI_API_KEY")}`,
    ].join("\n");
    expect(
      workflowSecretIssues("silent.yml", silent).some((p) =>
        p.includes("visible secret-gate skip")
      )
    ).toBe(true);
  });

  it("accepts the existing secret-gate pattern and GITHUB_TOKEN", () => {
    const ok = [
      "jobs:",
      "  secret-gate:",
      "    outputs:",
      `      provider: ${gh("steps.detect.outputs.provider")}`,
      "    steps:",
      "      - id: detect",
      "        run: |",
      '          echo "### Check skipped: AI_API_KEY is not configured." >> "$GITHUB_STEP_SUMMARY"',
      "        env:",
      `          AI_API_KEY: ${gh("secrets.AI_API_KEY")}`,
      "  eval:",
      "    needs: secret-gate",
      "    if: needs.secret-gate.outputs.provider == 'true'",
      "    steps:",
      "      - run: pnpm eval:provider",
      "        env:",
      `          AI_API_KEY: ${gh("secrets.AI_API_KEY")}`,
      `          AI_BASE_URL: ${gh("secrets.AI_BASE_URL || 'https://example.invalid'")}`,
      `          GITHUB_TOKEN: ${gh("secrets.GITHUB_TOKEN")}`,
    ].join("\n");
    expect(workflowSecretIssues("ok.yml", ok)).toEqual([]);
  });
});

describe("governance: deferred list is drift-protected (VAL-GOV-058)", () => {
  it("holds the deferred list in the required-files manifest", () => {
    expect(REQUIRED_FILES).toContain(DEFERRED_DOC);
    for (const file of REQUIRED_FILES) {
      const tracked = spawnSync("git", ["ls-files", "--error-unmatch", file], {
        encoding: "utf8",
      });
      expect(tracked.status, tracked.stderr).toBe(0);
    }
  });

  it("rejects extra item sections and duplicate inventories", () => {
    expect(REQUIRED_ITEMS).toHaveLength(11);
    const extra = `${doc}\n### 99. Hosted feature flags\n\n- Status: deferred (external-only)\n`;
    expect(
      inventoryProblems(extra).some((p) => p.includes("unknown deferred item"))
    ).toBe(true);
  });
});
