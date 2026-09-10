import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureScope, writeJsonFixture } from "./test-fixtures.mjs";

const scope = createFixtureScope("bundle-output-");
afterEach(scope.cleanup);

function file(root, path, bytes) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), Buffer.alloc(bytes));
}

function packageGate(name, args) {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const [bin, ...command] = manifest.scripts[name].split(" ");
  return spawnSync(bin, [...command, ...args], { encoding: "utf8" });
}

describe("published output budgets through package scripts", () => {
  it.each([
    "internal/module.js",
    "extensions/latex/dist/mathjax-worker.js",
    "assets/font.woff2",
  ])("rejects growth in %s without entrypoint growth", (path) => {
    const root = scope.dir();
    file(root, "dist/index.js", 100);
    file(root, `dist/${path}`, 100);
    const baseline = writeJsonFixture(root, "budget.json", {
      version: 1,
      tolerancePercent: 5,
      artifacts: { "dist/": 200, "dist/index.js": 100 },
    });
    const args = ["--root", root, "--baseline", baseline];
    expect(packageGate("check:bundle-size", args).status).toBe(0);
    file(root, `dist/${path}`, 111);
    const changed = packageGate("check:bundle-size", args);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("OVER dist/: measured=211");
    expect(changed.stderr).not.toContain("OVER dist/index.js");
  });

  it("includes newly emitted assets automatically", () => {
    const root = scope.dir();
    file(root, "dist/index.js", 100);
    const baseline = writeJsonFixture(root, "budget.json", {
      version: 1,
      tolerancePercent: 0,
      artifacts: { "dist/": 100 },
    });
    const args = ["--root", root, "--baseline", baseline];
    expect(packageGate("check:bundle-size", args).status).toBe(0);
    file(root, "dist/new-worker.wasm", 1);
    expect(packageGate("check:bundle-size", args).status).toBe(1);
  });

  it("rejects absent and empty dist trees", () => {
    const root = scope.dir();
    const baseline = writeJsonFixture(root, "budget.json", {
      version: 1,
      tolerancePercent: 0,
      artifacts: { "dist/": 100 },
    });
    const args = ["--root", root, "--baseline", baseline];
    expect(packageGate("check:bundle-size", args).status).toBe(1);
    mkdirSync(join(root, "dist"));
    const result = packageGate("check:bundle-size", args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MISSING dist/");
  });

  it("executes the workspace drift gate without a user-supplied mode", () => {
    const root = scope.dir();
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: [apps/*]\n");
    writeJsonFixture(root, "package.json", { dependencies: { zod: "4.0.0" } });
    mkdirSync(join(root, "apps", "a"), { recursive: true });
    writeJsonFixture(root, "apps/a/package.json", {
      optionalDependencies: { zod: "3.0.0" },
    });
    const baseline = writeJsonFixture(root, "baseline.json", {
      version: 1,
      signatures: [],
    });
    const result = packageGate("check:workspace-drift", [
      "--root",
      root,
      "--baseline",
      baseline,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MISMATCH zod");
  });
});
