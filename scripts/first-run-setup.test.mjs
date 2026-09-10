// Invariants for first-run setup (VAL-CROSS-001): the documented Node 24 /
// pnpm 11.9 setup stays credential-free and pinned to package.json, every
// validation entrypoint advertised by README/AGENTS/CONTRIBUTING resolves to
// a real root script, and each gate script's binaries exist after the
// documented `pnpm install --frozen-lockfile` — no undocumented prerequisite.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  advertisedCommandProblems,
  credentialDemands,
  firstRunProblems,
  gateInvokabilityProblems,
  readSetupDocs,
  SETUP_COMMAND,
  setupStatementProblems,
  toolchainProblems,
  transcriptProblems,
} from "./first-run-setup.mjs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const docs = readSetupDocs();
const readme = docs.find((entry) => entry.doc === "README.md").text;

describe("cross: documented setup statement (VAL-CROSS-001)", () => {
  it("documents Node 24, pnpm 11.9, the frozen-lockfile install, and the offline gate", () => {
    expect(setupStatementProblems(readme)).toEqual([]);
  });

  it("fails when the setup statement drifts", () => {
    const drifted = readme
      .replace("Node 24", "Node 22")
      .replace("pnpm 11.9", "pnpm 10.8")
      .replace(SETUP_COMMAND, "pnpm install")
      .replace("runs entirely offline", "runs against hosted services");
    const problems = setupStatementProblems(drifted);
    expect(problems).toContain(
      "README does not document the Node 24 requirement"
    );
    expect(problems).toContain(
      "README does not document the pnpm 11.9 requirement"
    );
    expect(problems).toContain(
      `README does not document the setup command \`${SETUP_COMMAND}\``
    );
    expect(problems).toContain(
      "README does not state the local quality gate runs entirely offline"
    );
  });

  it("keeps package.json engines/packageManager in agreement with the docs", () => {
    expect(toolchainProblems(pkg)).toEqual([]);
  });

  it("fails on toolchain drift between docs and package.json", () => {
    expect(
      toolchainProblems({
        engines: { node: ">=25" },
        packageManager: "pnpm@10.8.0",
      })
    ).toEqual([
      'package.json engines.node ">=25" does not cover the documented Node 24',
      'package.json packageManager "pnpm@10.8.0" does not pin the documented pnpm 11.9.0',
    ]);
    // An engines range that still admits Node 24 is not drift.
    expect(
      toolchainProblems({
        engines: { node: ">=24" },
        packageManager: "pnpm@11.9.0+sha512.deadbeef",
      })
    ).toEqual([]);
  });
});

describe("cross: setup demands no credentials (VAL-CROSS-001)", () => {
  it("has no login/token demand in the setup and validation docs", () => {
    const hits = docs.flatMap(({ doc, text }) =>
      credentialDemands(text).map((line) => `${doc}: ${line}`)
    );
    expect(hits).toEqual([]);
  });

  it("fails on an injected credential demand", () => {
    expect(credentialDemands("Run npm login before installing.")).toEqual([
      "Run npm login before installing.",
    ]);
    expect(credentialDemands("Set NPM_TOKEN in your shell first.")).toEqual([
      "Set NPM_TOKEN in your shell first.",
    ]);
    expect(credentialDemands("registry configuration: _authToken=…")).toEqual([
      "registry configuration: _authToken=…",
    ]);
    expect(
      credentialDemands("pnpm install --frozen-lockfile needs no credentials")
    ).toEqual([]);
  });
});

describe("cross: advertised commands resolve (VAL-CROSS-001)", () => {
  it("resolves every pnpm command advertised by README/AGENTS/CONTRIBUTING", () => {
    const scripts = new Set(Object.keys(pkg.scripts ?? {}));
    expect(advertisedCommandProblems(docs, scripts)).toEqual([]);
  });

  it("fails on an advertised command with no root script", () => {
    const problems = advertisedCommandProblems(
      [
        { doc: "README.md", text: "run pnpm deploy:prod now" },
        { doc: "AGENTS.md", text: "pnpm install --frozen-lockfile" },
      ],
      new Set(["lint"])
    );
    expect(problems).toEqual(["README.md: pnpm deploy:prod"]);
  });
});

describe("cross: gate entrypoints are invokable post-install (VAL-CROSS-001)", () => {
  it("resolves every gate script binary through the documented install", () => {
    const exists = (rel) => existsSync(join(".", rel));
    expect(gateInvokabilityProblems(pkg.scripts ?? {}, exists)).toEqual([]);
  });

  it("fails on a gate binary or node script the install does not provide", () => {
    const nothing = () => false;
    const problems = gateInvokabilityProblems(
      {
        lint: "ultracite check .",
        typecheck: "turbo run typecheck && tsc -p tsconfig.json --noEmit",
        build: "node scripts/missing-gate.mjs",
        test: "nosuchbin run",
        coverage: "pnpm --filter x build && vitest run",
        "api:check": "node scripts/runtime-public-api.mjs check",
        "verify:edge": "pnpm --filter x build",
      },
      nothing
    );
    expect(problems).toContain(
      "lint: binary not provided by the documented install: ultracite"
    );
    expect(problems).toContain(
      "typecheck: binary not provided by the documented install: turbo"
    );
    expect(problems).toContain(
      "build: node script missing: scripts/missing-gate.mjs"
    );
    expect(problems).toContain(
      "test: binary not provided by the documented install: nosuchbin"
    );
    // pnpm-prefixed segments are built-ins and never flagged.
    expect(problems.some((line) => line.startsWith("coverage: pnpm"))).toBe(
      false
    );
  });
});

describe("cross: harness transcript hygiene (VAL-CROSS-001)", () => {
  it("accepts a clean install transcript that only names the npm registry", () => {
    const clean =
      "$ pnpm install --frozen-lockfile\nexit=0\nProgress: resolved 1204, reused 1204 from registry.npmjs.org\nDone in 42s";
    expect(transcriptProblems("install.log", clean)).toEqual([]);
  });

  it("fails on credential prompts, registry auth failures, and production endpoints", () => {
    expect(
      transcriptProblems(
        "install.log",
        "ERR_PNPM_FETCH_401 GET https://registry.npmjs.org/x"
      )
    ).toEqual(["install.log: transcript shows a credential prompt/failure"]);
    expect(transcriptProblems("install.log", "username: ")).toEqual([
      "install.log: transcript shows a credential prompt/failure",
    ]);
    expect(
      transcriptProblems(
        "lint.log",
        "POST https://api.telegram.org/bot123/sendMessage"
      )
    ).toEqual(["lint.log: transcript references a production endpoint"]);
    expect(
      transcriptProblems("lint.log", "fetch https://my-app.workers.dev/healthz")
    ).toEqual(["lint.log: transcript references a production endpoint"]);
  });
});

describe("cross: aggregate first-run invariant (VAL-CROSS-001)", () => {
  it("passes against the committed tree", () => {
    expect(firstRunProblems()).toEqual([]);
  });
});
