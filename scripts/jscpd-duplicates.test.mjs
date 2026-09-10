import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST_SCOPES,
  allowlistEntryProblems,
  bareWildcardProblems,
  ignoreCoverageProblems,
  ignorePatternsForRun,
  JSCPD_BASELINE_PATH,
  JSCPD_CONFIG_PATH,
  JSCPD_REPORT_PATH,
  readJscpdConfig,
  scopedAllowlistProblems,
  signatureForDuplicate,
  signaturesFromReport,
  thresholdProblems,
} from "./jscpd-duplicates.mjs";
import {
  baselineProblems,
  CODEOWNERS_PATH,
  codeownersCoverageProblems,
  diffSignatures,
} from "./knip-unused.mjs";

const configSource = readFileSync(JSCPD_CONFIG_PATH, "utf8");
const config = readJscpdConfig();
const rootScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;

describe("jscpd: duplicate-code configuration", () => {
  it("config is strict valid JSON with positive thresholds, wired to the named root scripts (VAL-SEC-007)", () => {
    expect(() => JSON.parse(configSource)).not.toThrow();
    expect(thresholdProblems(config)).toEqual([]);
    expect(rootScripts["check:duplicates"]).toBe(
      "node scripts/check-duplicates.mjs"
    );
    expect(rootScripts["check:duplicates:report"]).toBe(
      "node scripts/check-duplicates.mjs --report"
    );
  });

  it("rejects missing or non-positive thresholds (VAL-SEC-007)", () => {
    expect(thresholdProblems({ ...config, minTokens: 0 })).not.toEqual([]);
    expect(thresholdProblems({ ...config, minLines: 0 })).not.toEqual([]);
    expect(thresholdProblems({ ...config, minTokens: "70" })).not.toEqual([]);
    const { minLines, ...withoutMinLines } = config;
    expect(thresholdProblems(withoutMinLines)).not.toEqual([]);
    expect(minLines).toBeGreaterThan(0);
  });

  it("`pnpm check:duplicates --help` exits 0 without running the tool (VAL-SEC-007)", () => {
    const result = spawnSync(
      "node",
      ["scripts/check-duplicates.mjs", "--help"],
      { encoding: "utf8" }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--report");
  });

  it("excludes generated and third-party paths (VAL-SEC-003)", () => {
    expect(ignoreCoverageProblems(config)).toEqual([]);
  });

  it("fails when a required generated-path exclusion is removed (VAL-SEC-003)", () => {
    const mutated = structuredClone(config);
    mutated.ignore = mutated.ignore.filter((p) => !p.includes("dist"));
    expect(ignoreCoverageProblems(mutated).join("\n")).toContain("dist");
  });

  it("contains no bare-wildcard suppression (VAL-SEC-005)", () => {
    expect(bareWildcardProblems(config)).toEqual([]);
  });

  it("rejects a bare-wildcard suppression entry (VAL-SEC-005)", () => {
    const mutated = structuredClone(config);
    mutated.allowlist.push({
      name: "suppress-everything",
      path: "**",
      justification: "attempted blanket suppression of all findings",
    });
    expect(bareWildcardProblems(mutated).join("\n")).toContain("**");
  });

  it("covers examples/ and experimental/ with path-scoped allowlist entries, not whole-scope disables (VAL-SEC-006)", () => {
    expect(scopedAllowlistProblems(config)).toEqual([]);
    for (const scope of ALLOWLIST_SCOPES) {
      expect(
        config.allowlist.some(
          (entry) =>
            typeof entry.path === "string" && entry.path.startsWith(scope)
        ),
        scope
      ).toBe(true);
    }
  });

  it("flags a missing or whole-scope allowlist entry (VAL-SEC-006)", () => {
    const removed = structuredClone(config);
    removed.allowlist = removed.allowlist.filter(
      (entry) => !entry.path.startsWith("experimental/")
    );
    expect(scopedAllowlistProblems(removed).join("\n")).toContain(
      "experimental/"
    );
    const disabled = structuredClone(config);
    disabled.allowlist = [
      {
        name: "examples-off",
        path: "examples/**",
        justification: "suppresses every example finding at once",
      },
    ];
    expect(scopedAllowlistProblems(disabled).join("\n")).toContain(
      "examples/**"
    );
  });

  it("every allowlist entry is named, scoped, and justified (VAL-SEC-005)", () => {
    expect(allowlistEntryProblems(config)).toEqual([]);
  });

  it("rejects an unjustified allowlist entry (VAL-SEC-005)", () => {
    const mutated = structuredClone(config);
    mutated.allowlist[0].justification = "";
    expect(allowlistEntryProblems(mutated).join("\n")).toContain(
      "justification"
    );
  });

  it("the wrapper merges config ignores with allowlist paths for the run", () => {
    const merged = ignorePatternsForRun(config);
    for (const entry of config.allowlist) {
      expect(merged).toContain(entry.path);
    }
    for (const pattern of config.ignore) {
      expect(merged).toContain(pattern);
    }
  });

  it("tool config and baseline paths are CODEOWNERS-covered (VAL-SEC-005)", () => {
    const codeowners = readFileSync(CODEOWNERS_PATH, "utf8");
    expect(
      codeownersCoverageProblems(codeowners, [
        JSCPD_CONFIG_PATH,
        JSCPD_BASELINE_PATH,
        "scripts/check-duplicates.mjs",
      ])
    ).toEqual([]);
  });
});

describe("jscpd: signature baseline", () => {
  it("baseline is signature-based: sorted, unique duplicate-block fingerprints (VAL-SEC-002)", () => {
    const baseline = JSON.parse(readFileSync(JSCPD_BASELINE_PATH, "utf8"));
    expect(baselineProblems(baseline)).toEqual([]);
    expect(
      baseline.signatures.every((signature) =>
        signature.startsWith("duplicates:")
      )
    ).toBe(true);
  });

  it("diffs findings against the baseline by signature (VAL-SEC-002)", () => {
    const diff = diffSignatures(
      ["duplicates:a.ts:1-9=b.ts:1-9", "duplicates:c.ts:1-9=d.ts:1-9"],
      ["duplicates:a.ts:1-9=b.ts:1-9", "duplicates:e.ts:1-9=f.ts:1-9"]
    );
    expect(diff.newSignatures).toEqual(["duplicates:c.ts:1-9=d.ts:1-9"]);
    expect(diff.staleSignatures).toEqual(["duplicates:e.ts:1-9=f.ts:1-9"]);
  });

  it("builds stable endpoint-ordered fingerprints from a jscpd JSON report", () => {
    const report = {
      duplicates: [
        {
          firstFile: { name: "src/b.ts", start: 20, end: 28 },
          secondFile: { name: "src/a.ts", start: 1, end: 9 },
        },
        {
          firstFile: { name: "src/a.ts", start: 1, end: 9 },
          secondFile: { name: "src/b.ts", start: 20, end: 28 },
        },
      ],
    };
    expect(signaturesFromReport(report)).toEqual([
      "duplicates:src/a.ts:1-9=src/b.ts:20-28",
    ]);
    expect(
      signatureForDuplicate({
        firstFile: { name: "x.ts", start: 3, end: 8 },
        secondFile: { name: "x.ts", start: 30, end: 35 },
      })
    ).toBe("duplicates:x.ts:3-8=x.ts:30-35");
  });

  it("report output path is gitignored and never tracked (VAL-SEC-008 hygiene)", () => {
    const ignored = spawnSync("git", ["check-ignore", "-q", JSCPD_REPORT_PATH]);
    expect(ignored.status).toBe(0);
    const tracked = spawnSync("git", ["ls-files", JSCPD_REPORT_PATH], {
      encoding: "utf8",
    });
    expect(tracked.stdout.trim()).toBe("");
  });
});
