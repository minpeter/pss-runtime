import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Invariants for the Worker coverage gate (VAL-SEC-020..023): the Worker
// package owns a coverage configuration with explicit scope and thresholds,
// independent of the root core-only gate; the chosen minimum is documented;
// and the coverage path never starts Wrangler dev or real providers.
// Deterministic, offline, no ports, no shared temp state.

const WORKER_DIR = "apps/worker-agent";
const WORKER_CONFIG_PATH = `${WORKER_DIR}/vitest.config.ts`;
const ROOT_COVERAGE_CONFIG_PATH = "vitest.coverage.config.ts";
const WORKER_README_PATH = `${WORKER_DIR}/README.md`;
const WORKER_PACKAGE_PATH = `${WORKER_DIR}/package.json`;

const THRESHOLD_METRICS = ["statements", "branches", "functions", "lines"];
const WORKER_AGENT_PATTERN = /worker-agent/;
const APPS_WORKER_PATTERN = /apps\/worker/;
const COVERAGE_HEADING_PATTERN = /#{2,}[^\n]*coverage/i;
const COVERAGE_SCRIPT_PATTERN = /test:coverage/;
const NOT_ZERO_PATTERN = /not zero|why not zero|never zero/i;
const COVERAGE_SUBJECT_PATTERN = /health|metrics|contract/i;
const WRANGLER_PATTERN = /wrangler/;
const WRANGLER_DEV_PATTERN = /wrangler\s+dev/;
const REAL_EVAL_PATTERN = /PSS_WORKER_AGENT_EVAL_REAL/;
const REAL_EVAL_ENABLED_PATTERN = /PSS_WORKER_AGENT_EVAL_REAL=1/;

async function loadWorkerConfig() {
  const module = await import("../apps/worker-agent/vitest.config.ts");
  return module.default;
}

function readRepoFile(path) {
  return readFileSync(path, "utf8");
}

describe("worker coverage configuration (VAL-SEC-020)", () => {
  it("worker vitest config declares its own coverage.thresholds block", async () => {
    const config = await loadWorkerConfig();
    expect(
      config.test,
      "worker config must declare a test block"
    ).toBeDefined();
    const coverage = config.test.coverage;
    expect(
      coverage,
      "worker config must declare its own coverage block"
    ).toBeDefined();
    expect(
      coverage.thresholds,
      "worker coverage must declare a thresholds block"
    ).toBeDefined();
    expect(typeof coverage.thresholds).toBe("object");
  });

  it("root coverage config does not reference the Worker package", () => {
    const rootConfig = readRepoFile(ROOT_COVERAGE_CONFIG_PATH);
    expect(rootConfig).not.toMatch(WORKER_AGENT_PATTERN);
    expect(rootConfig).not.toMatch(APPS_WORKER_PATTERN);
  });
});

describe("worker coverage scope and thresholds (VAL-SEC-021)", () => {
  it("declares an explicit include scope over the Worker source tree", async () => {
    const config = await loadWorkerConfig();
    const include = config.test.coverage.include ?? [];
    // The config lives in apps/worker-agent, so `src/**/*.ts` is the exact
    // equivalent of `apps/worker-agent/src/**/*.ts`.
    expect(include).toContain("src/**/*.ts");
  });

  it("excludes tests, test-* shims, and generated files", async () => {
    const config = await loadWorkerConfig();
    const exclude = config.test.coverage.exclude ?? [];
    const excludesTests = exclude.some((pattern) => pattern.includes(".test."));
    const excludesShims = exclude.some(
      (pattern) => pattern.includes("testing") || pattern.includes("test-shim")
    );
    const excludesGenerated = exclude.some(
      (pattern) => pattern.includes(".d.ts") || pattern.includes("generated")
    );
    expect(excludesTests, `exclude must cover tests: ${exclude}`).toBe(true);
    expect(excludesShims, `exclude must cover test shims: ${exclude}`).toBe(
      true
    );
    expect(excludesGenerated, `exclude must cover generated: ${exclude}`).toBe(
      true
    );
  });

  it("declares each threshold as a finite number in (0, 100]", async () => {
    const config = await loadWorkerConfig();
    const thresholds = config.test.coverage.thresholds;
    for (const metric of THRESHOLD_METRICS) {
      const value = thresholds[metric];
      expect(
        typeof value,
        `${metric} threshold must be declared as a number`
      ).toBe("number");
      expect(Number.isFinite(value), `${metric} must be finite`).toBe(true);
      expect(value, `${metric} must be greater than zero`).toBeGreaterThan(0);
      expect(value, `${metric} must be at or below 100`).toBeLessThanOrEqual(
        100
      );
    }
  });

  it("documents the chosen minimum and why it is not zero", () => {
    const readme = readRepoFile(WORKER_README_PATH);
    expect(
      COVERAGE_HEADING_PATTERN.test(readme),
      "Worker README must have a coverage section"
    ).toBe(true);
    expect(readme).toMatch(COVERAGE_SCRIPT_PATTERN);
    expect(
      NOT_ZERO_PATTERN.test(readme),
      "README must state why the minimum is not zero"
    ).toBe(true);
    expect(
      COVERAGE_SUBJECT_PATTERN.test(readme),
      "README must state what the minimum covers"
    ).toBe(true);
  });

  it("writes reports to a gitignored directory", async () => {
    const config = await loadWorkerConfig();
    const reportsDirectory = config.test.coverage.reportsDirectory;
    expect(typeof reportsDirectory).toBe("string");
    const ignored = spawnSync(
      "git",
      ["check-ignore", `${WORKER_DIR}/${reportsDirectory}`],
      { encoding: "utf8" }
    );
    expect(
      ignored.status,
      `${WORKER_DIR}/${reportsDirectory} must be gitignored`
    ).toBe(0);
  });
});

describe("worker coverage isolation (VAL-SEC-023)", () => {
  it("declares a test:coverage script that enables coverage", () => {
    const packageJson = JSON.parse(readRepoFile(WORKER_PACKAGE_PATH));
    const script = packageJson.scripts["test:coverage"];
    expect(script, "worker package must declare test:coverage").toBeDefined();
    expect(script).toContain("vitest run");
    expect(script).toContain("--coverage");
  });

  it("coverage path never starts wrangler dev or real providers", () => {
    const packageJson = JSON.parse(readRepoFile(WORKER_PACKAGE_PATH));
    const script = packageJson.scripts["test:coverage"] ?? "";
    expect(script).not.toMatch(WRANGLER_PATTERN);
    expect(script).not.toMatch(REAL_EVAL_ENABLED_PATTERN);
    const configText = readRepoFile(WORKER_CONFIG_PATH);
    expect(configText).not.toMatch(WRANGLER_DEV_PATTERN);
    expect(configText).not.toMatch(REAL_EVAL_PATTERN);
  });
});
