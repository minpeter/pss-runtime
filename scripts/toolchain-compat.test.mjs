import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  CI_WORKFLOW_PATH,
  ciWiringProblems,
  readRepoFile,
} from "./local-quality-invariants.mjs";
import {
  docTexts,
  enginesProblems,
  NEW_TOOL_DEV_DEPENDENCIES,
  NODE_MATRIX_PROBES,
  satisfiesRange,
  TOOL_BINARIES,
  typedocProblems,
} from "./toolchain-compat.mjs";

// Invariants for VAL-SEC-044: the new analysis/security tools run on the
// Node 24/26 ci.yml matrix, every new tool devDependency's engines.node
// admits both matrix legs, the binaries execute on the current Node, the
// toolchain stays on TypeScript 7, and TypeDoc remains excluded with the
// exclusion documented. Deterministic, offline, no ports.

const ROOT_PACKAGE_PATH = "package.json";
const LOCKFILE_PATH = "pnpm-lock.yaml";
const VERSION_OUTPUT = /\d+\.\d+\.\d+/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("toolchain: Node 24/26 matrix (VAL-SEC-044)", () => {
  it("ci.yml runs the checks job on Node 24 and Node 26 under network isolation", () => {
    expect(ciWiringProblems(readRepoFile(CI_WORKFLOW_PATH))).toEqual([]);
    const doc = parseYaml(readRepoFile(CI_WORKFLOW_PATH));
    const nodes = (doc?.jobs?.checks?.strategy?.matrix?.node ?? []).map(String);
    expect(nodes).toContain("24");
    expect(nodes).toContain("26");
  });

  it("the repo engines range admits both matrix legs", () => {
    const range = readJson(ROOT_PACKAGE_PATH).engines?.node;
    expect(typeof range).toBe("string");
    for (const probe of NODE_MATRIX_PROBES) {
      expect(
        satisfiesRange(probe, range),
        `engines.node "${range}" must admit Node ${probe}`
      ).toBe(true);
    }
  });

  it("every new tool devDependency's engines.node admits the matrix", () => {
    expect(enginesProblems()).toEqual([]);
  });

  it("satisfiesRange evaluates the range forms the tools declare", () => {
    expect(satisfiesRange("24.0.0", "^20.19.0 || >=22.12.0")).toBe(true);
    expect(satisfiesRange("26.0.0", "^20.19.0 || >=22.12.0")).toBe(true);
    expect(satisfiesRange("24.0.0", ">=22.22.1")).toBe(true);
    expect(satisfiesRange("26.0.0", ">= 14.6")).toBe(true);
    expect(satisfiesRange("24.18.0", ">=24")).toBe(true);
  });

  it("satisfiesRange rejects versions outside a declared range", () => {
    // Negative cases: a range excluding either matrix leg must not pass.
    expect(satisfiesRange("26.0.0", ">=18 <25")).toBe(false);
    expect(satisfiesRange("24.0.0", "^0.84.1")).toBe(false);
    expect(satisfiesRange("26.0.0", "not-a-range")).toBe(false);
    expect(satisfiesRange("24.0.0", "")).toBe(false);
  });

  it("the tool binaries execute on the current Node", () => {
    const major = Number(process.versions.node.split(".")[0]);
    expect(major).toBeGreaterThanOrEqual(24);
    for (const binary of TOOL_BINARIES) {
      const result = spawnSync(`node_modules/.bin/${binary}`, ["--version"], {
        encoding: "utf8",
      });
      expect(result.error, `${binary} must spawn`).toBeUndefined();
      expect(result.status, `${binary} --version must exit 0`).toBe(0);
      expect(
        VERSION_OUTPUT.test(`${result.stdout}${result.stderr}`),
        `${binary} --version must print a version`
      ).toBe(true);
    }
    expect(TOOL_BINARIES.length).toBeGreaterThan(0);
  });
});

describe("toolchain: TypeScript 7 and the TypeDoc exclusion (VAL-SEC-044)", () => {
  it("the installed TypeScript toolchain is TypeScript 7", () => {
    const installed = readJson("node_modules/typescript/package.json").version;
    expect(installed.startsWith("7.")).toBe(true);
  });

  it("no typedoc devDependency, script, or lockfile entry exists", () => {
    expect(
      typedocProblems(
        readJson(ROOT_PACKAGE_PATH),
        readRepoFile(LOCKFILE_PATH),
        docTexts()
      )
    ).toEqual([]);
  });

  it("the docs statement scan flags a missing exclusion statement", () => {
    // Negative case: without any doc carrying the statement, the scan fails.
    const problems = typedocProblems(readJson(ROOT_PACKAGE_PATH), "", [
      "no tooling statement here",
    ]);
    expect(problems.some((line) => line.includes("TypeDoc exclusion"))).toBe(
      true
    );
  });

  it("the dependency scan flags a typedoc fixture", () => {
    // Negative case: an added typedoc devDependency must fail the scan.
    const fixture = { devDependencies: { typedoc: "0.0.0" }, scripts: {} };
    const problems = typedocProblems(fixture, "", []);
    expect(problems.some((line) => line.includes("typedoc"))).toBe(true);
  });

  it("the declared new-tool set is a subset of root devDependencies", () => {
    const devDependencies = readJson(ROOT_PACKAGE_PATH).devDependencies ?? {};
    for (const name of NEW_TOOL_DEV_DEPENDENCIES) {
      expect(
        Object.hasOwn(devDependencies, name),
        `${name} must be a declared root devDependency`
      ).toBe(true);
    }
  });
});
