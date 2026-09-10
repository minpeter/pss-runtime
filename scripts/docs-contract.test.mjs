import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agreementProblems,
  canonicalFacts,
  comparedDocs,
  docFacets,
  docProblems,
  WORKER_HOST,
  WORKER_PORT,
} from "./docs-contract.mjs";

// Cross-surface docs agreement (VAL-CROSS-002): agent-facing skills, root
// AGENTS.md, README, CONTRIBUTING, and the Worker health runbook must agree
// with the repository's machine-readable truth on setup, toolchain, ports,
// credentials, and cleanup. Credential-shaped fixtures are built at runtime
// so no scanner ever sees a full token literal in source.

const FAKE_PROVIDER_KEY = ["sk", "A1b2".repeat(10)].join("-");
const FAKE_NPM_TOKEN = ["NPM", "TOKEN"].join("_");

const FACTS = {
  nodeMin: 24,
  pnpmVersion: "11.9.0",
  installRuns: ["pnpm install --frozen-lockfile"],
  worker: {
    host: "127.0.0.1",
    port: 8792,
    devWorker: "wrangler dev -e dev",
    predev: "pnpm -F @minpeter/pss-runtime build",
  },
};

const WORKER_DOC =
  "## Worker\n\n" +
  "1. `pnpm --filter @minpeter/pss-runtime build`\n" +
  "2. `pnpm --filter @minpeter/pss-worker-agent dev:worker`\n\n" +
  "Wrangler binds `127.0.0.1:8792` on the loopback interface.\n";

describe("docs agreement (VAL-CROSS-002)", () => {
  it("shipped docs carry no conflicting command, port, or credential value", () => {
    expect(agreementProblems()).toEqual([]);
  });

  it("canonical facts pin Node 24, pnpm 11.9, frozen install, loopback worker", () => {
    const facts = canonicalFacts();
    expect(facts.nodeMin).toBe(24);
    expect(facts.pnpmVersion).toBe("11.9.0");
    expect(facts.installRuns).toContain("pnpm install --frozen-lockfile");
    expect(facts.worker.host).toBe(WORKER_HOST);
    expect(facts.worker.port).toBe(WORKER_PORT);
    expect(facts.worker.devWorker).toBe("wrangler dev -e dev");
    expect(facts.worker.predev).toContain("@minpeter/pss-runtime build");
  });

  it("normalized port and endpoint values form a single loopback set", () => {
    const endpoints = new Set();
    const wordPorts = new Set();
    const installers = new Set();
    for (const doc of comparedDocs()) {
      const facets = docFacets(readFileSync(doc, "utf8"));
      for (const value of facets.endpoints) {
        endpoints.add(value);
      }
      for (const value of facets.wordPorts) {
        wordPorts.add(value);
      }
      for (const value of facets.installers) {
        installers.add(value);
      }
    }
    expect([...endpoints]).toEqual([`${WORKER_HOST}:${WORKER_PORT}`]);
    expect([...wordPorts]).toEqual([String(WORKER_PORT)]);
    expect([...installers]).toEqual([]);
  });

  it("flags a conflicting toolchain claim", () => {
    expect(
      docProblems("d", "Requires Node 20 and pnpm 10.2.\n", FACTS)
    ).not.toEqual([]);
    expect(
      docProblems("d", "Requires Node 24 and pnpm 11.9.\n", FACTS)
    ).toEqual([]);
  });

  it("flags a non-pnpm install instruction", () => {
    expect(
      docProblems("d", "Set up with npm install and go.\n", FACTS)
    ).not.toEqual([]);
    expect(
      docProblems("d", "Run `pnpm install --frozen-lockfile`.\n", FACTS)
    ).toEqual([]);
  });

  it("flags any non-8792 or non-loopback endpoint", () => {
    expect(
      docProblems("d", "Probe http://127.0.0.1:3000/healthz.\n", FACTS).length
    ).toBeGreaterThan(0);
    expect(
      docProblems("d", "The Worker port 3401 is used.\n", FACTS).length
    ).toBeGreaterThan(0);
    expect(docProblems("d", "Binds `127.0.0.1:8792` only.\n", FACTS)).toEqual(
      []
    );
  });

  it("flags credential literals and credential-gated validation claims", () => {
    expect(docProblems("d", `key: ${FAKE_PROVIDER_KEY}\n`, FACTS)).not.toEqual(
      []
    );
    expect(docProblems("d", `set ${FAKE_NPM_TOKEN}=x\n`, FACTS)).not.toEqual(
      []
    );
    expect(
      docProblems("d", "Local validation requires an API key.\n", FACTS)
    ).not.toEqual([]);
    // Placeholder reads and negated mentions are compatible guidance.
    expect(docProblems("d", "apiKey: process.env.AI_API_KEY\n", FACTS)).toEqual(
      []
    );
    expect(
      docProblems("d", "The battery requires no API key.\n", FACTS)
    ).toEqual([]);
  });

  it("flags cleanup contradictions and combined dev-script validation", () => {
    expect(
      docProblems("d", "Leave the worker running after validation.\n", FACTS)
    ).not.toEqual([]);
    expect(
      docProblems("d", "Run pnpm dev to validate the worker.\n", FACTS)
    ).not.toEqual([]);
    expect(
      docProblems("d", "The dev:relay script is never invoked here.\n", FACTS)
    ).toEqual([]);
  });

  it("requires the loopback binding and runtime build with dev:worker", () => {
    const missing = docProblems(
      "d",
      "Use `dev:worker` to validate the Worker.\n",
      FACTS
    );
    expect(missing.length).toBe(2);
    expect(docProblems("d", WORKER_DOC, FACTS)).toEqual([]);
  });
});
