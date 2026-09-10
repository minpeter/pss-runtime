// Cross-surface documentation agreement invariants (VAL-CROSS-002). The
// repository skills, root AGENTS.md, README, CONTRIBUTING, and the Worker
// health runbook the skills point at must describe compatible setup,
// toolchain, Worker-validation, credential, and cleanup rules. Every
// documented claim is normalized and compared against the repository's
// machine-readable truth (package.json pins, the Wrangler dev binding, the
// worker package scripts, and the ci.yml install step); a conflicting value
// fails. Static over committed files: no network, no ports, no writes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { OFF_LIMITS_PORTS } from "./governance-runbooks.mjs";
import { skillFiles } from "./governance-skills.mjs";
import { parseJsonc } from "./jsonc.mjs";

export const CORE_DOCS = ["AGENTS.md", "README.md", "CONTRIBUTING.md"];
export const WORKER_HEALTH_RUNBOOK = "docs/runbooks/worker-health.md";
export const CI_WORKFLOW = ".github/workflows/ci.yml";
export const WORKER_PACKAGE = "apps/worker-agent/package.json";
export const WRANGLER_CONFIG = "apps/worker-agent/wrangler.jsonc";
export const WORKER_PORT = 8792;
export const WORKER_HOST = "127.0.0.1";

const NODE_CLAIM = /\bnode(?:\.js)?\s*(?:>=\s*)?(\d{2})\b/gi;
const PNPM_VERSION_CLAIM = /\bpnpm\s+(\d+\.\d+(?:\.\d+)?)\b/g;
const NON_PNPM_INSTALL = /\b(npm|yarn|bun|deno)\s+(?:install|i|add)\b/gi;
const HOST_PORT = /\b((?:\d{1,3}\.){3}\d{1,3}|localhost|\[::1\]):(\d{2,5})\b/g;
const PORT_WORD = /\bports?\s+(\d{2,5})\b/gi;
const LOOPBACK_HOST = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])$/;
const DEV_WORKER = /\bdev:worker\b/;
const WRANGLER_DEV = /\bwrangler\s+dev\b/;
const LOOPBACK_BINDING = /\b127\.0\.0\.1:8792\b/;
const RUNTIME_BUILD_FIRST =
  /\bpnpm\s+(?:--filter|-F)\s+@minpeter\/pss-runtime\s+build\b/;
const BARE_DEV = /\bpnpm\s+dev(?![:\w-])/;
const DEV_RELAY = /\bdev:relay\b/;
const FROZEN_INSTALL = /\bpnpm\s+install\s+--frozen-lockfile\b/;
const INSTALL_STEP = /\bpnpm\s+install\b/;
const PINNED_NODE = /(\d{2})/;
const PINNED_PNPM = /pnpm@(\d+\.\d+\.\d+)/;
const PRE_DEV_BUILDS_RUNTIME = /@minpeter\/pss-runtime build/;
const CREDENTIAL_LITERAL =
  /NPM_TOKEN|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|\d{6,}:[A-Za-z0-9_-]{20,}/;
const CREDENTIAL_REQUIREMENT =
  /\b(?:requires?|needs?|must\s+(?:have|provide|set|supply))\b[^\n.;]*\b(?:api[- ]?keys?|credentials?|secrets?|tokens?)\b/i;
const CLEANUP_BYPASS =
  /\b(?:leave|leaving|keeps?|keeping)\b[^\n.;]*\b(?:running|listeners?|process(?:es)?|ports?|temp(?:orary)?)\b/i;
const NEGATION =
  /\b(?:no|never|not|without|placeholders?|scripted|don'?t|instead)\b/i;

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function ciInstallRuns(ciDoc) {
  const runs = [];
  for (const job of Object.values(ciDoc?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      const run = typeof step?.run === "string" ? step.run.trim() : "";
      if (INSTALL_STEP.test(run)) {
        runs.push(run);
      }
    }
  }
  return runs;
}

// The machine-readable truth the docs are compared against.
export function canonicalFacts(root = ".") {
  const pkg = readJson(root, "package.json");
  const workerPkg = readJson(root, WORKER_PACKAGE);
  const wrangler = parseJsonc(
    readFileSync(join(root, WRANGLER_CONFIG), "utf8")
  );
  const ci = parseYaml(readFileSync(join(root, CI_WORKFLOW), "utf8"));
  return {
    nodeMin: Number(PINNED_NODE.exec(pkg.engines?.node ?? "")?.[1]),
    pnpmVersion: PINNED_PNPM.exec(pkg.packageManager ?? "")?.[1] ?? null,
    installRuns: ciInstallRuns(ci),
    worker: {
      host: wrangler?.dev?.ip,
      port: wrangler?.dev?.port,
      devWorker: workerPkg.scripts?.["dev:worker"] ?? "",
      predev: workerPkg.scripts?.predev ?? "",
    },
  };
}

// The canonical facts themselves must hold, or no comparison is meaningful.
export function factProblems(facts) {
  const problems = [];
  if (facts.nodeMin !== 24) {
    problems.push("package.json engines.node must pin Node >=24");
  }
  if (typeof facts.pnpmVersion !== "string") {
    problems.push("package.json packageManager must pin pnpm@x.y.z");
  }
  if (!facts.installRuns.includes("pnpm install --frozen-lockfile")) {
    problems.push(
      "ci.yml install step is not `pnpm install --frozen-lockfile`"
    );
  }
  if (facts.worker.host !== WORKER_HOST || facts.worker.port !== WORKER_PORT) {
    problems.push(
      `wrangler dev binding must be ${WORKER_HOST}:${WORKER_PORT}, found ${facts.worker.host}:${facts.worker.port}`
    );
  }
  if (facts.worker.devWorker !== "wrangler dev -e dev") {
    problems.push(
      `worker dev:worker script must be \`wrangler dev -e dev\`, found: ${facts.worker.devWorker}`
    );
  }
  if (!PRE_DEV_BUILDS_RUNTIME.test(facts.worker.predev)) {
    problems.push("worker predev script does not build the runtime first");
  }
  return problems;
}

// Normalized claims extracted from one document.
export function docFacets(text) {
  const endpoints = new Set();
  for (const match of text.matchAll(HOST_PORT)) {
    endpoints.add(`${match[1]}:${match[2]}`);
  }
  return {
    endpoints,
    wordPorts: new Set([...text.matchAll(PORT_WORD)].map((m) => m[1])),
    installers: new Set(
      [...text.matchAll(NON_PNPM_INSTALL)].map((m) => m[1].toLowerCase())
    ),
    nodeMajors: new Set(
      [...text.matchAll(NODE_CLAIM)].map((m) => Number(m[1]))
    ),
    pnpmVersions: new Set(
      [...text.matchAll(PNPM_VERSION_CLAIM)].map((m) => m[1])
    ),
  };
}

function facetProblems(doc, text, facets, facts) {
  const problems = [];
  for (const major of facets.nodeMajors) {
    if (major < facts.nodeMin) {
      problems.push(
        `${doc} requires Node ${major}; the toolchain pin is Node >=${facts.nodeMin}`
      );
    }
  }
  for (const version of facets.pnpmVersions) {
    if (!facts.pnpmVersion?.startsWith(version)) {
      problems.push(
        `${doc} documents pnpm ${version}; the packageManager pin is ${facts.pnpmVersion}`
      );
    }
  }
  for (const installer of facets.installers) {
    problems.push(
      `${doc} instructs a non-pnpm install (${installer}); setup is pnpm-only`
    );
  }
  for (const endpoint of facets.endpoints) {
    const host = endpoint.slice(0, endpoint.lastIndexOf(":"));
    const port = Number(endpoint.slice(endpoint.lastIndexOf(":") + 1));
    if (!LOOPBACK_HOST.test(host) || port !== facts.worker.port) {
      problems.push(
        `${doc} references endpoint ${endpoint}; the only local endpoint is ${WORKER_HOST}:${facts.worker.port}`
      );
    }
  }
  for (const port of facets.wordPorts) {
    if (Number(port) !== facts.worker.port) {
      problems.push(
        `${doc} references port ${port}; only the Worker port ${facts.worker.port} may be documented`
      );
    }
  }
  for (const banned of OFF_LIMITS_PORTS) {
    if (new RegExp(`(?<!\\d)${banned}(?!\\d)`).test(text)) {
      problems.push(`${doc} references off-limits port ${banned}`);
    }
  }
  return problems;
}

function lineProblems(doc, text) {
  const problems = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (NEGATION.test(line)) {
      continue;
    }
    if (CREDENTIAL_REQUIREMENT.test(line)) {
      problems.push(
        `${doc} claims local validation requires external credentials: ${line}`
      );
    }
    if (CLEANUP_BYPASS.test(line)) {
      problems.push(`${doc} contradicts the cleanup rule: ${line}`);
    }
    if (BARE_DEV.test(line) || DEV_RELAY.test(line)) {
      problems.push(
        `${doc} instructs the combined dev/relay script as a validation step: ${line}`
      );
    }
  }
  return problems;
}

// Every conflicting claim in one document.
export function docProblems(doc, text, facts) {
  const problems = [
    ...facetProblems(doc, text, docFacets(text), facts),
    ...lineProblems(doc, text),
  ];
  if (CREDENTIAL_LITERAL.test(text)) {
    problems.push(`${doc} contains a credential-shaped literal`);
  }
  if (DEV_WORKER.test(text) || WRANGLER_DEV.test(text)) {
    if (!LOOPBACK_BINDING.test(text)) {
      problems.push(
        `${doc} describes Worker validation without the ${WORKER_HOST}:${WORKER_PORT} loopback binding`
      );
    }
    if (!RUNTIME_BUILD_FIRST.test(text)) {
      problems.push(
        `${doc} describes Worker validation without the explicit runtime build first`
      );
    }
  }
  return problems;
}

// The compared document set: agent-facing skills, root AGENTS.md, README,
// CONTRIBUTING, and the Worker health runbook the skills reference.
export function comparedDocs(root = ".") {
  const docs = [...CORE_DOCS, WORKER_HEALTH_RUNBOOK];
  for (const { file } of skillFiles(root)) {
    docs.push(file);
  }
  return docs;
}

export function agreementProblems(root = ".") {
  const facts = canonicalFacts(root);
  const problems = [...factProblems(facts)];
  let workerValidationDocs = 0;
  let frozenInstallDocs = 0;
  for (const doc of comparedDocs(root)) {
    let text;
    try {
      text = readFileSync(join(root, doc), "utf8");
    } catch {
      problems.push(`${doc} is missing`);
      continue;
    }
    problems.push(...docProblems(doc, text, facts));
    if (DEV_WORKER.test(text) || WRANGLER_DEV.test(text)) {
      workerValidationDocs += 1;
    }
    if (FROZEN_INSTALL.test(text)) {
      frozenInstallDocs += 1;
    }
  }
  if (workerValidationDocs === 0) {
    problems.push(
      "no compared document describes local Worker validation via dev:worker"
    );
  }
  if (frozenInstallDocs === 0) {
    problems.push("no compared document documents the frozen-lockfile install");
  }
  return problems;
}
