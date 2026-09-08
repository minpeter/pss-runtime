// Fixture proofs for the post-run cleanup inventory logic (VAL-CROSS-013):
// `ss -tlnp`/`ps` parsing, baseline diffs that flag only validator-attributable
// leaks (never foreign listener churn), the unignored-artifact scan, and the
// observe-only source contract of scripts/check-validation-cleanup.mjs.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  harnessProblems,
  inventoryProblems,
  parseListeners,
  untrackedArtifacts,
  VALIDATOR_PORTS,
  validatorProcesses,
} from "./validation-cleanup.mjs";

const HARNESS_PATH = "scripts/check-validation-cleanup.mjs";

// A captured `ss -tlnp` sample. The peer column uses `[::]:*` because the
// loopback-only scanner forbids the wildcard bind literal in script sources;
// the parser never reads peer tokens anyway.
const SS_SAMPLE = [
  "State    Recv-Q   Send-Q     Local Address:Port      Peer Address:Port   Process",
  'LISTEN   0        511        127.0.0.1:8792           [::]:*          users:(("node",pid=101,fd=22))',
  'LISTEN   0        511        127.0.0.1:3400           [::]:*          users:(("next-server",pid=55,fd=19))',
  'LISTEN   0        100        [::1]:9999              [::]:*             users:(("bun",pid=77,fd=3))',
].join("\n");

const PS_CLEAN = ["  55 next-server /opt/app", "  77 bun run dev"].join("\n");
const PS_LEAKED = `${PS_CLEAN}\n  404 node node_modules/.bin/wrangler dev -e dev`;

const BASELINE = {
  listeners: parseListeners(SS_SAMPLE).filter(
    (listener) => listener.port !== 8792
  ),
  processes: validatorProcesses(PS_CLEAN),
};

function inventoryWith(listeners, psText = PS_CLEAN) {
  return {
    listeners: [...BASELINE.listeners, ...listeners],
    processes: validatorProcesses(psText),
  };
}

describe("parseListeners", () => {
  it("parses ss -tlnp rows with address, port, and process attribution", () => {
    const listeners = parseListeners(SS_SAMPLE);
    expect(listeners).toHaveLength(3);
    expect(listeners[0]).toEqual({
      address: "127.0.0.1",
      port: 8792,
      processName: "node",
      pid: 101,
    });
    expect(listeners[2]).toEqual({
      address: "[::1]",
      port: 9999,
      processName: "bun",
      pid: 77,
    });
  });

  it("skips headers and non-listener rows", () => {
    expect(
      parseListeners("State Recv-Q\nESTAB 0 0 1.2.3.4:5 6.7.8.9:10")
    ).toEqual([]);
  });
});

describe("validatorProcesses", () => {
  it("matches only validator command-line markers", () => {
    expect(validatorProcesses(PS_CLEAN)).toEqual([]);
    expect(validatorProcesses(PS_LEAKED)).toEqual([
      { pid: 404, command: "node node_modules/.bin/wrangler dev -e dev" },
    ]);
  });

  it("ignores marker names embedded in longer tokens", () => {
    expect(
      validatorProcesses("  900 bash -c exec pss-fake-wrangler sleep 60")
    ).toEqual([]);
  });
});

describe("inventoryProblems", () => {
  it("accepts an unchanged inventory", () => {
    expect(inventoryProblems(BASELINE, BASELINE).problems).toEqual([]);
  });

  it("flags a new listener on a validation port as a leaked validator", () => {
    const leaked = parseListeners(SS_SAMPLE).find(
      (listener) => listener.port === 8792
    );
    const { problems } = inventoryProblems(
      BASELINE,
      inventoryWith([{ ...leaked, pid: 202 }])
    );
    expect(problems.join("\n")).toContain("8792");
    expect(problems.join("\n")).toContain("leaked validator listener");
  });

  it("flags a new listener on an off-limits port as a boundary violation", () => {
    const { problems } = inventoryProblems(
      BASELINE,
      inventoryWith([
        { address: "127.0.0.1", port: 3000, processName: "node", pid: 303 },
      ])
    );
    expect(problems.join("\n")).toContain("off-limits port 3000");
  });

  it("flags a new validator-marked process and a listener it holds", () => {
    const { problems } = inventoryProblems(
      BASELINE,
      inventoryWith(
        [{ address: "127.0.0.1", port: 49_152, processName: "node", pid: 404 }],
        PS_LEAKED
      )
    );
    expect(problems.join("\n")).toContain("leaked validator process");
    expect(problems.join("\n")).toContain("49152");
  });

  it("ignores foreign listener churn unattributable to validation", () => {
    const result = inventoryProblems(
      BASELINE,
      inventoryWith([
        { address: "127.0.0.1", port: 45_321, processName: "bun", pid: 77 },
      ])
    );
    expect(result.problems).toEqual([]);
    expect(result.foreignChurn).toHaveLength(1);
  });

  it("does not flag a baseline validator that is still running", () => {
    const runningWorker = {
      listeners: parseListeners(SS_SAMPLE),
      processes: [{ pid: 101, command: "node wrangler dev -e dev" }],
    };
    expect(inventoryProblems(runningWorker, runningWorker).problems).toEqual(
      []
    );
  });
});

describe("untrackedArtifacts", () => {
  it("flags only untracked, non-ignored paths", () => {
    const porcelain = " M CONTRIBUTING.md\nA  scripts/x.mjs\n?? scratch.ts\n";
    expect(untrackedArtifacts(porcelain)).toEqual(["scratch.ts"]);
  });

  it("accepts a clean or staged-only tree", () => {
    expect(untrackedArtifacts("")).toEqual([]);
    expect(untrackedArtifacts("M  scripts/x.mjs\n")).toEqual([]);
  });
});

describe("check-validation-cleanup harness source contract", () => {
  const source = readFileSync(HARNESS_PATH, "utf8");

  it("keeps the observe-only, baseline-diff contract", () => {
    expect(harnessProblems(source)).toEqual([]);
  });

  it("rejects a harness that terminates processes", () => {
    expect(harnessProblems(`${source}\nprocess.kill(pid);\n`)).not.toEqual([]);
    expect(harnessProblems(`${source}\n// pkill node\n`)).not.toEqual([]);
  });

  it("rejects a harness without a baseline or timeout guard", () => {
    expect(
      harnessProblems(source.replaceAll('"--baseline"', '"--baselin"'))
    ).not.toEqual([]);
    expect(
      harnessProblems(source.replaceAll("timeout:", "timeut:"))
    ).not.toEqual([]);
  });

  it("rejects a harness that opens sockets or calls the network", () => {
    expect(harnessProblems(`${source}\nimport "node:net";\n`)).not.toEqual([]);
    expect(harnessProblems(`${source}\nawait fetch(url);\n`)).not.toEqual([]);
  });
});

describe("validation port inventory", () => {
  it("covers exactly the declared validation services", () => {
    expect(VALIDATOR_PORTS).toEqual([8792, 8793]);
  });
});
