import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEV_WORKER_COMMAND,
  REQUIRED_SCRIPT_KEYS,
  readJson,
  runbookEvidenceProblems,
  WORKER_HEALTH_RUNBOOK,
  WORKER_PACKAGE_JSON,
  workerScriptProblems,
} from "./worker-lifecycle.mjs";

// Worker Wrangler lifecycle invariants (VAL-WORKER-034/035/037): the
// validation startup contract is an explicit runtime build followed by
// `dev:worker` (`wrangler dev -e dev`), and the worker-health runbook
// documents the ss/lsof listener-diff, bounded-readiness, and teardown
// evidence procedure. Static over committed files; negative cases mandatory.

const realScripts = readJson(WORKER_PACKAGE_JSON).scripts;

describe("worker lifecycle package scripts (VAL-WORKER-034)", () => {
  it("declares predev, dev, dev:worker, and dev:relay as distinct scripts", () => {
    for (const key of REQUIRED_SCRIPT_KEYS) {
      expect(typeof realScripts[key], key).toBe("string");
    }
    expect(workerScriptProblems(realScripts)).toEqual([]);
  });

  it("pins dev:worker to the exact wrangler dev command", () => {
    expect(realScripts["dev:worker"]).toBe(DEV_WORKER_COMMAND);
  });

  it("keeps predev as the explicit runtime build paired with dev only", () => {
    expect(realScripts.predev).toContain("@minpeter/pss-runtime build");
    expect("predev:worker" in realScripts).toBe(false);
  });

  it("fails when a required script key is missing", () => {
    const { dev: _dev, ...rest } = realScripts;
    const problems = workerScriptProblems(rest);
    expect(problems.some((p) => p.includes('"dev"'))).toBe(true);
  });

  it("fails when dev:worker is re-pointed or padded", () => {
    expect(
      workerScriptProblems({ ...realScripts, "dev:worker": "wrangler dev" })
    ).not.toEqual([]);
    expect(
      workerScriptProblems({
        ...realScripts,
        "dev:worker": `${DEV_WORKER_COMMAND} --port 8793`,
      })
    ).not.toEqual([]);
  });

  it("fails when predev no longer builds the runtime", () => {
    expect(
      workerScriptProblems({ ...realScripts, predev: "echo noop" })
    ).not.toEqual([]);
  });

  it("fails when the combined dev script loses a leg", () => {
    expect(
      workerScriptProblems({ ...realScripts, dev: "run-p dev:worker" })
    ).not.toEqual([]);
  });

  it("fails when the relay script is repurposed", () => {
    expect(
      workerScriptProblems({ ...realScripts, "dev:relay": "echo noop" })
    ).not.toEqual([]);
  });

  it("fails when a predev:worker hook smuggles the build into dev:worker", () => {
    expect(
      workerScriptProblems({ ...realScripts, "predev:worker": "echo build" })
    ).not.toEqual([]);
  });
});

describe("worker-health runbook lifecycle evidence procedure (VAL-WORKER-035/037)", () => {
  const text = readFileSync(WORKER_HEALTH_RUNBOOK, "utf8");

  it("documents the ss/lsof snapshots, bounded readiness, and teardown", () => {
    expect(runbookEvidenceProblems(text)).toEqual([]);
  });

  it("fails when the evidence procedure is stripped", () => {
    expect(runbookEvidenceProblems("# Worker health\n")).not.toEqual([]);
  });
});
