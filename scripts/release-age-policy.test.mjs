import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseExcludeEntry,
  parseWorkspaceConfig,
  readLockfilePackageIndex,
  resolveExcludes,
  validateExcludeList,
  validateMinimumReleaseAge,
} from "./release-age-policy.mjs";

// Preserve parsed policy values, not YAML formatting or comment wording.
const EXPECTED_WORKSPACE_SOURCE = `packages:
  - "apps/*"
  - "packages/*"
  - "examples/*"
  - "experimental/*"
  - "extensions/*"
autoInstallPeers: false
overrides:
  # Security-only, parent-scoped resolutions where direct updates cannot reach the vulnerable edge.
  # Keep these exact so unrelated consumers retain their declared dependency ranges.
  '@ai-sdk/provider-utils@3.0.31>undici': 6.28.0
  'nanoid@3.3.17': 3.3.18
  'dockerode@4.0.12>uuid': 11.1.1
  'miniflare@5.20260730.0-alpha>undici': 7.29.0
  'miniflare@5.20260820.0-alpha>sharp': 0.35.4
  'miniflare@5.20260908.0-alpha>sharp': 0.35.4
  read-yaml-file: 2.1.0
  typescript: ^7.0.2
  rolldown-plugin-dts: 0.27.2
  vite: 8.1.0
allowBuilds:
  core-js-pure: true
  cpu-features: false
  esbuild: true
  protobufjs: false
  sharp: true
  ssh2: false
  workerd: true
# Supply-chain guard: only install versions published at least this many minutes ago.
minimumReleaseAge: 1440
minimumReleaseAgeExclude:
  - '@minpeter/opensearch@0.1.3'
  - typescript
  - '@typescript/*'
  - rolldown-plugin-dts
  - '@ai-sdk/gateway@4.0.22 || 4.0.40'
  - ai@7.0.30 || 7.0.51
  - '@ai-sdk/provider-utils@5.0.20 || 5.0.22'
  - '@ai-sdk/provider@4.0.5'
  - '@ai-sdk/openai@4.0.31'
`;

const EXPECTED_EXCLUDES = [
  "@minpeter/opensearch@0.1.3",
  "typescript",
  "@typescript/*",
  "rolldown-plugin-dts",
  "@ai-sdk/gateway@4.0.22 || 4.0.40",
  "ai@7.0.30 || 7.0.51",
  "@ai-sdk/provider-utils@5.0.20 || 5.0.22",
  "@ai-sdk/provider@4.0.5",
  "@ai-sdk/openai@4.0.31",
];

const PACKAGE_MANAGER_PIN_PATTERN = /^pnpm@11\.9\.0\+sha512\.[0-9a-f]+$/;

const workspaceSource = readFileSync("pnpm-workspace.yaml", "utf8");
const lockfileSource = readFileSync("pnpm-lock.yaml", "utf8");

describe("minimum release age policy", () => {
  it("preserves every declared top-level policy value", () => {
    expect(parseWorkspaceConfig(workspaceSource)).toEqual(
      parseWorkspaceConfig(EXPECTED_WORKSPACE_SOURCE)
    );
  });

  it("declares an explicit, positive minimumReleaseAge in minutes", () => {
    const { config, error } = parseWorkspaceConfig(workspaceSource);
    expect(error).toBeNull();
    expect(validateMinimumReleaseAge(config)).toEqual([]);
    expect(config.minimumReleaseAge).toBeGreaterThan(0);
  });

  it("rejects absent, empty, malformed, and non-positive values", () => {
    const cases = [
      [{}, "must be declared"],
      [{ minimumReleaseAge: null }, "must be non-empty"],
      [{ minimumReleaseAge: "" }, "must be non-empty"],
      [{ minimumReleaseAge: "  " }, "must be non-empty"],
      [{ minimumReleaseAge: "1440" }, "number of minutes"],
      [{ minimumReleaseAge: "1 day" }, "number of minutes"],
      [{ minimumReleaseAge: Number.NaN }, "number of minutes"],
      [{ minimumReleaseAge: 0 }, "must be positive"],
      [{ minimumReleaseAge: -60 }, "must be positive"],
    ];
    for (const [config, message] of cases) {
      const problems = validateMinimumReleaseAge(config);
      expect(problems, JSON.stringify(config)).toHaveLength(1);
      expect(problems[0]).toContain("minimumReleaseAge");
      expect(problems[0]).toContain(message);
    }
  });

  it("keeps the exclude list exactly as declared", () => {
    const { config, error } = parseWorkspaceConfig(workspaceSource);
    expect(error).toBeNull();
    expect(
      validateExcludeList(config.minimumReleaseAgeExclude, EXPECTED_EXCLUDES)
    ).toEqual([]);
  });

  it("fails with the entry named when an exclusion is removed or added", () => {
    const removed = EXPECTED_EXCLUDES.slice(1);
    expect(
      validateExcludeList(removed, EXPECTED_EXCLUDES).join("\n")
    ).toContain('missing entry "@minpeter/opensearch@0.1.3"');
    const broadened = [...EXPECTED_EXCLUDES, "left-pad"];
    expect(
      validateExcludeList(broadened, EXPECTED_EXCLUDES).join("\n")
    ).toContain('unexpected entry "left-pad"');
  });

  it("resolves every exclude entry to a version present in the lockfile", () => {
    const { config, error } = parseWorkspaceConfig(workspaceSource);
    expect(error).toBeNull();
    const lockIndex = readLockfilePackageIndex(lockfileSource);
    const { problems, resolutions } = resolveExcludes(
      config.minimumReleaseAgeExclude,
      lockIndex
    );
    expect(problems).toEqual([]);
    for (const { entry, matches, pinnedHits } of resolutions) {
      expect(matches.length, entry).toBeGreaterThan(0);
      if (parseExcludeEntry(entry).versions.length > 0) {
        expect(pinnedHits.length, entry).toBeGreaterThan(0);
      }
    }
  });

  it("fails with the entry named when an exclusion goes stale", () => {
    const lockIndex = readLockfilePackageIndex(lockfileSource);
    const stale = ["definitely-not-a-dependency@1.0.0"];
    const { problems } = resolveExcludes(stale, lockIndex);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("definitely-not-a-dependency@1.0.0");
    const staleGlob = resolveExcludes(["@no-such-scope/*"], lockIndex);
    expect(staleGlob.problems[0]).toContain("@no-such-scope/*");
  });

  it("rejects pins after their versions leave a still-resolved package", () => {
    const index = new Map([["@scope/pkg", new Set(["2.0.0"])]]);
    for (const entry of ["@scope/pkg@1.0.0", "@scope/pkg@1.0.0 || 1.1.0"]) {
      const result = resolveExcludes([entry], index);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toContain(entry);
      expect(result.resolutions).toEqual([]);
    }
    for (const entry of [
      "@scope/pkg",
      "@scope/*",
      "@scope/pkg@1.0.0 || 2.0.0",
    ]) {
      expect(resolveExcludes([entry], index).problems).toEqual([]);
    }
  });

  it("parses ||-ranged exclusions into name plus version alternatives", () => {
    expect(parseExcludeEntry("ai@7.0.30 || 7.0.51")).toEqual({
      name: "ai",
      versions: ["7.0.30", "7.0.51"],
    });
    expect(parseExcludeEntry("@ai-sdk/gateway@4.0.22 || 4.0.40")).toEqual({
      name: "@ai-sdk/gateway",
      versions: ["4.0.22", "4.0.40"],
    });
    expect(parseExcludeEntry("typescript")).toEqual({
      name: "typescript",
      versions: [],
    });
    expect(parseExcludeEntry("@typescript/*")).toEqual({
      name: "@typescript/*",
      versions: [],
    });
    expect(parseExcludeEntry("name@").error).toContain("empty version");
    expect(parseExcludeEntry("a@1 || ").error).toContain("empty term");
  });
});

describe("toolchain pins", () => {
  it("keeps the pnpm and Node toolchain pins unchanged", () => {
    const rootPackageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(rootPackageJson.packageManager).toMatch(PACKAGE_MANAGER_PIN_PATTERN);
    expect(rootPackageJson.engines.node).toBe(">=24");
    expect(readFileSync(".node-version", "utf8").trim()).toBe("24");
  });
});
