import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatResult, parseArgs } from "./time-gate.mjs";

// Behavioral contract for the timing wrapper (VAL-LOCAL-024). Unlike the six
// config checks this test spawns short-lived node children — that is the
// wrapper's subject. Fixture writes stay under the gitignored .omo/ tree and
// are removed afterwards.

const WRAPPER = "scripts/time-gate.mjs";
const SCRATCH_DIR = ".omo/tmp/time-gate-test";
const OK_LINE = /^GATE quick: elapsed=\d+\.\ds bound=20s result=ok$/;

function runGate(wrapperArgs) {
  return spawnSync("node", [WRAPPER, ...wrapperArgs], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("time-gate argument parsing", () => {
  it("parses --bound, --label, and the gate command", () => {
    expect(
      parseArgs([
        "--bound",
        "60",
        "--label",
        "pre-commit",
        "--",
        "git",
        "status",
      ])
    ).toEqual({
      bound: 60,
      label: "pre-commit",
      command: "git",
      args: ["status"],
    });
  });

  it("rejects malformed invocations with a named problem", () => {
    expect(parseArgs(["--bound", "60"]).error).toContain("`--`");
    expect(parseArgs(["--bound", "60", "--"]).error).toContain(
      "no gate command"
    );
    expect(parseArgs(["--label", "x", "--", "true"]).error).toContain(
      "--bound"
    );
    expect(parseArgs(["--bound", "1", "--", "true"]).error).toContain(
      "--label"
    );
    expect(
      parseArgs(["--bound", "abc", "--label", "x", "--", "true"]).error
    ).toContain("positive number");
    expect(
      parseArgs(["--bound", "0", "--label", "x", "--", "true"]).error
    ).toContain("positive number");
    expect(
      parseArgs(["--bound", "1", "--nope", "x", "--", "true"]).error
    ).toContain("unknown flag");
  });

  it("formats a stable one-line result", () => {
    expect(formatResult("pre-commit", 3.24, 60, "ok")).toBe(
      "GATE pre-commit: elapsed=3.2s bound=60s result=ok"
    );
  });
});

describe("time-gate execution", () => {
  it("reports ok for a gate that exits 0 within its bound", () => {
    const run = runGate([
      "--bound",
      "20",
      "--label",
      "quick",
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(OK_LINE);
  });

  it("propagates a failing gate exit code", () => {
    const run = runGate([
      "--bound",
      "20",
      "--label",
      "failing",
      "--",
      "node",
      "-e",
      "process.exit(3)",
    ]);
    expect(run.status).toBe(1);
    expect(run.stdout.trim()).toContain("result=failed:3");
  });

  it("kills the whole process group on timeout, leaving no survivors", {
    timeout: 30_000,
  }, () => {
    mkdirSync(SCRATCH_DIR, { recursive: true });
    const pidFile = `${SCRATCH_DIR}/grandchild.pid`;
    rmSync(pidFile, { force: true });
    // The gate spawns a grandchild that records its pid and sleeps; both
    // stay in the wrapper child's process group, so the group kill must
    // reap the grandchild too.
    const gate = [
      "const { spawnSync, spawn } = await import('node:child_process');",
      "const { writeFileSync } = await import('node:fs');",
      `const grandchild = spawn('node', ['-e', 'setTimeout(()=>{},30000)']);`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
      "setTimeout(() => {}, 30000);",
    ].join("\n");
    const run = runGate([
      "--bound",
      "2",
      "--label",
      "hang",
      "--",
      "node",
      "--input-type=module",
      "-e",
      gate,
    ]);
    try {
      expect(run.status).toBe(1);
      expect(run.stdout.trim()).toContain("result=timeout");
      expect(existsSync(pidFile)).toBe(true);
      const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
      let alive = true;
      try {
        process.kill(grandchildPid, 0);
      } catch {
        alive = false;
      }
      expect(alive, `grandchild pid ${grandchildPid} survived`).toBe(false);
    } finally {
      rmSync(SCRATCH_DIR, { recursive: true, force: true });
    }
  });
});
