import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLOWLIST_SCOPES,
  allowlistMarkerProblems,
  bareWildcardProblems,
  baselineProblems,
  CODEOWNERS_PATH,
  codeownersCoverageProblems,
  diffSignatures,
  ignoreCoverageProblems,
  KNIP_BASELINE_PATH,
  KNIP_CONFIG_PATH,
  KNIP_REPORT_PATH,
  readKnipConfig,
  scopedAllowlistProblems,
  signatureFor,
  signaturesFromReport,
  workspaceGlobs,
  workspaceScopeProblems,
} from "./knip-unused.mjs";

const configSource = readFileSync(KNIP_CONFIG_PATH, "utf8");
const config = readKnipConfig();
const rootScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;

describe("knip: unused-code configuration", () => {
  it("config parses as valid knip input and wires the named root scripts (VAL-SEC-001)", () => {
    expect(config.workspaces).toBeTypeOf("object");
    expect(rootScripts["check:unused"]).toBe("node scripts/check-unused.mjs");
    expect(rootScripts["check:unused:report"]).toBe(
      "node scripts/check-unused.mjs --report"
    );
  });

  it("`pnpm check:unused --help` exits 0 without the tool (VAL-SEC-001)", () => {
    const result = spawnSync("node", ["scripts/check-unused.mjs", "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--report");
  });

  it("workspace entry patterns are a subset of pnpm-workspace.yaml globs (VAL-SEC-001)", () => {
    expect(workspaceScopeProblems(config, workspaceGlobs())).toEqual([]);
  });

  it("flags a workspace entry outside the pnpm workspace globs (VAL-SEC-001)", () => {
    const mutated = structuredClone(config);
    mutated.workspaces["vendor/*"] = {};
    expect(
      workspaceScopeProblems(mutated, workspaceGlobs()).join("\n")
    ).toContain("vendor/*");
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
    mutated.workspaces["examples/*"].ignore = ["**"];
    expect(bareWildcardProblems(mutated).join("\n")).toContain("**");
  });

  it("covers examples/ and experimental/ with path-scoped allowlist entries, not global disables (VAL-SEC-006)", () => {
    expect(scopedAllowlistProblems(config)).toEqual([]);
    for (const scope of ALLOWLIST_SCOPES) {
      expect(config.workspaces[scope], scope).toBeDefined();
    }
  });

  it("flags a missing or global-disable allowlist entry (VAL-SEC-006)", () => {
    const removed = structuredClone(config);
    removed.workspaces["experimental/*"] = undefined;
    expect(scopedAllowlistProblems(removed).join("\n")).toContain(
      "experimental/*"
    );
    const disabled = structuredClone(config);
    disabled.workspaces["examples/*"] = {
      rules: { files: "off", exports: "off" },
    };
    expect(scopedAllowlistProblems(disabled).join("\n")).toContain(
      "examples/*"
    );
  });

  it("every suppression scope is named and justified by an allowlist marker (VAL-SEC-005)", () => {
    expect(allowlistMarkerProblems(configSource, config)).toEqual([]);
  });

  it("rejects an unjustified allowlist entry (VAL-SEC-005)", () => {
    const stripped = configSource.replace(/\/\/ allowlist\[[^\n]*\n/g, "");
    expect(allowlistMarkerProblems(stripped, config).join("\n")).toContain(
      "examples/*"
    );
  });

  it("tool config and baseline paths are CODEOWNERS-covered (VAL-SEC-005)", () => {
    const codeowners = readFileSync(CODEOWNERS_PATH, "utf8");
    expect(
      codeownersCoverageProblems(codeowners, [
        KNIP_CONFIG_PATH,
        KNIP_BASELINE_PATH,
        "scripts/check-unused.mjs",
      ])
    ).toEqual([]);
  });
});

describe("knip: signature baseline", () => {
  it("baseline is signature-based: sorted, unique file+symbol entries (VAL-SEC-002)", () => {
    const baseline = JSON.parse(readFileSync(KNIP_BASELINE_PATH, "utf8"));
    expect(baselineProblems(baseline)).toEqual([]);
    expect(baseline.signatures.length).toBeGreaterThan(0);
    expect(
      baseline.signatures.every((signature) => signature.includes(":"))
    ).toBe(true);
  });

  it("rejects malformed, duplicate, or unsorted baseline entries (VAL-SEC-002)", () => {
    expect(baselineProblems({ version: 1, signatures: [42] })).not.toEqual([]);
    expect(
      baselineProblems({
        version: 1,
        signatures: ["exports:a.ts#x", "exports:a.ts#x"],
      })
    ).not.toEqual([]);
    expect(
      baselineProblems({
        version: 1,
        signatures: ["exports:b.ts#y", "exports:a.ts#x"],
      })
    ).not.toEqual([]);
  });

  it("diffs findings against the baseline by signature (VAL-SEC-002)", () => {
    const diff = diffSignatures(
      ["exports:a.ts#x", "exports:b.ts#y"],
      ["exports:a.ts#x", "exports:c.ts#z"]
    );
    expect(diff.newSignatures).toEqual(["exports:b.ts#y"]);
    expect(diff.staleSignatures).toEqual(["exports:c.ts#z"]);
  });

  it("builds stable signatures from a knip JSON report", () => {
    const report = {
      issues: [
        { file: "src/unused.ts", files: [{ name: "src/unused.ts" }] },
        { file: "src/a.ts", exports: [{ name: "foo" }] },
      ],
    };
    expect(signaturesFromReport(report)).toEqual([
      "exports:src/a.ts#foo",
      "files:src/unused.ts",
    ]);
    expect(signatureFor("files", "src/x.ts", "src/x.ts")).toBe(
      "files:src/x.ts"
    );
  });

  it("report output path is gitignored and never tracked (VAL-SEC-008 hygiene)", () => {
    const ignored = spawnSync("git", ["check-ignore", "-q", KNIP_REPORT_PATH]);
    expect(ignored.status).toBe(0);
    const tracked = spawnSync("git", ["ls-files", KNIP_REPORT_PATH], {
      encoding: "utf8",
    });
    expect(tracked.stdout.trim()).toBe("");
  });
});
