import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EDGE_DRY_RUN_JOB,
  EXTENDED_WORKFLOW_PATH,
  edgeJobProblems,
  entrypointProblems,
  ROOT_PACKAGE_JSON,
  VERIFY_EDGE_COMMAND,
  verifyEdgeScriptProblems,
  WORKER_BUILD_COMMAND,
  WORKER_ENTRYPOINT,
  WORKER_PACKAGE_JSON,
  WRANGLER_CONFIG_PATH,
  workflowSources,
} from "./worker-edge-dry-run.mjs";
import { readJson } from "./worker-lifecycle.mjs";

// Edge dry-run build invariants (VAL-WORKER-038): `pnpm verify:edge` is the
// exact command chain CI runs in extended-verification.yml's edge-dry-run
// job — root script -> worker build (`wrangler deploy --dry-run --env=""`
// with the update-check banner and metrics disabled, so zero egress and no
// deploy) after the prebuild runtime build — and the bundle entrypoint is
// src/index.ts. Static over committed files; negative cases mandatory.

const rootScripts = readJson(ROOT_PACKAGE_JSON).scripts;
const workerScripts = readJson(WORKER_PACKAGE_JSON).scripts;
const wranglerSource = readFileSync(WRANGLER_CONFIG_PATH, "utf8");
const workflows = workflowSources();

describe("verify:edge command chain (VAL-WORKER-038)", () => {
  it("pins the root script to the exact worker build filter", () => {
    expect(rootScripts["verify:edge"]).toBe(VERIFY_EDGE_COMMAND);
    expect(verifyEdgeScriptProblems(rootScripts, workerScripts)).toEqual([]);
  });

  it("pins the worker build to the egress-free dry-run deploy command", () => {
    expect(workerScripts.build).toBe(WORKER_BUILD_COMMAND);
    expect(workerScripts.build).toContain("--dry-run");
    expect(workerScripts.build).toContain("WRANGLER_HIDE_BANNER=true");
    expect(workerScripts.build).toContain("WRANGLER_SEND_METRICS=false");
  });

  it("keeps the runtime build as the prebuild step", () => {
    expect(workerScripts.prebuild).toContain("@minpeter/pss-runtime build");
  });

  it("keeps the real deploy in a separate script that is never dry-run", () => {
    expect(workerScripts["ship:worker"]).toContain("wrangler deploy");
    expect(workerScripts["ship:worker"]).not.toContain("--dry-run");
  });

  it("fails when the root script is re-pointed", () => {
    const problems = verifyEdgeScriptProblems(
      { ...rootScripts, "verify:edge": "echo noop" },
      workerScripts
    );
    expect(problems.some((p) => p.includes("verify:edge"))).toBe(true);
  });

  it("fails when the worker build drops the dry-run flag", () => {
    const problems = verifyEdgeScriptProblems(rootScripts, {
      ...workerScripts,
      build: 'wrangler deploy --env=""',
    });
    expect(problems.some((p) => p.includes("--dry-run"))).toBe(true);
  });

  it("fails when the worker build drops an egress suppression", () => {
    for (const build of [
      'WRANGLER_SEND_METRICS=false wrangler deploy --dry-run --env=""',
      'WRANGLER_HIDE_BANNER=true wrangler deploy --dry-run --env=""',
    ]) {
      const problems = verifyEdgeScriptProblems(rootScripts, {
        ...workerScripts,
        build,
      });
      expect(problems.some((p) => p.includes("zero egress"))).toBe(true);
    }
  });

  it("fails when the prebuild runtime build is removed", () => {
    expect(
      verifyEdgeScriptProblems(rootScripts, {
        ...workerScripts,
        prebuild: "echo noop",
      })
    ).not.toEqual([]);
  });

  it("fails when the real deploy script silently becomes a dry-run", () => {
    expect(
      verifyEdgeScriptProblems(rootScripts, {
        ...workerScripts,
        "ship:worker": 'wrangler deploy --dry-run --env=""',
      })
    ).not.toEqual([]);
  });
});

describe("edge bundle entrypoint (VAL-WORKER-038)", () => {
  it("bundles src/index.ts as the worker main", () => {
    expect(entrypointProblems(wranglerSource)).toEqual([]);
  });

  it("fails when the entrypoint moves", () => {
    const moved = wranglerSource.replace(
      `"main": "${WORKER_ENTRYPOINT}"`,
      '"main": "src/other.ts"'
    );
    expect(entrypointProblems(moved)).not.toEqual([]);
  });

  it("fails on an unparseable wrangler config", () => {
    expect(entrypointProblems("{ not jsonc")).not.toEqual([]);
  });
});

describe("CI edge-dry-run job reference (VAL-WORKER-038)", () => {
  it("runs pnpm verify:edge exactly once, in the ungated edge-dry-run job", () => {
    expect(edgeJobProblems(workflows)).toEqual([]);
  });

  it("fails when the job switches to a different command", () => {
    const mutated = workflows.map(({ path, source }) => ({
      path,
      source:
        path === EXTENDED_WORKFLOW_PATH
          ? source.replace("run: pnpm verify:edge", "run: pnpm build")
          : source,
    }));
    expect(edgeJobProblems(mutated)).not.toEqual([]);
  });

  it("fails when the job is hidden behind the secret gate", () => {
    const mutated = workflows.map(({ path, source }) => ({
      path,
      source:
        path === EXTENDED_WORKFLOW_PATH
          ? source.replace(
              `${EDGE_DRY_RUN_JOB}:\n    if:`,
              `${EDGE_DRY_RUN_JOB}:\n    needs: secret-gate\n    if:`
            )
          : source,
    }));
    expect(
      mutated.some(
        ({ source }) => source.includes("needs: secret-gate") // sanity
      )
    ).toBe(true);
    expect(edgeJobProblems(mutated)).not.toEqual([]);
  });

  it("fails when a workflow step runs a real deploy", () => {
    const mutated = workflows.map(({ path, source }) => ({
      path,
      source:
        path === EXTENDED_WORKFLOW_PATH
          ? source.replace(
              "run: pnpm verify:edge",
              'run: pnpm verify:edge\n      - run: wrangler deploy --env=""'
            )
          : source,
    }));
    expect(edgeJobProblems(mutated)).not.toEqual([]);
  });
});
