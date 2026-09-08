// First-run setup invariants (VAL-CROSS-001): the documented Node 24 /
// pnpm 11.9 setup stays credential-free and pinned to package.json, every
// validation entrypoint advertised by README/AGENTS/CONTRIBUTING resolves to
// a real root script, and each milestone gate script's binaries are provided
// by the documented `pnpm install --frozen-lockfile` — no undocumented
// prerequisite, credential prompt, or production endpoint on the setup path.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_SCRIPTS } from "./governance-readme.mjs";
import { pnpmTokens } from "./governance-skills.mjs";
import { satisfiesRange } from "./toolchain-compat.mjs";

// Docs a first-run user or agent reads for setup and validation commands.
export const SETUP_DOCS = ["README.md", "AGENTS.md", "CONTRIBUTING.md"];

// The single documented setup command (README "Development").
export const SETUP_COMMAND = "pnpm install --frozen-lockfile";

// Documented toolchain anchors: README states "Node 24 and pnpm 11.9" and the
// packageManager field pins pnpm 11.9.0 exactly.
export const NODE_MAJOR_PROBE = "24.0.0";
export const PNPM_VERSION_PREFIX = "pnpm@11.9.0";

// Credential demands that must never appear on the setup/validation path.
const CREDENTIAL_DEMAND =
  /\b(?:npm login|pnpm login|npm adduser|_authToken|NPM_TOKEN)\b/;

const README_FILE = "README.md";
const NODE_DOC = "Node 24";
const PNPM_DOC = /pnpm 11\.9/;
const OFFLINE_DOC = /runs entirely offline/;

export function readSetupDocs(root = ".") {
  return SETUP_DOCS.map((doc) => ({
    doc,
    text: readFileSync(join(root, doc), "utf8"),
  }));
}

// The README setup statement must keep all four anchors (VAL-CROSS-001).
export function setupStatementProblems(readmeText) {
  const problems = [];
  if (!readmeText.includes(NODE_DOC)) {
    problems.push("README does not document the Node 24 requirement");
  }
  if (!PNPM_DOC.test(readmeText)) {
    problems.push("README does not document the pnpm 11.9 requirement");
  }
  if (!readmeText.includes(SETUP_COMMAND)) {
    problems.push(
      `README does not document the setup command \`${SETUP_COMMAND}\``
    );
  }
  if (!OFFLINE_DOC.test(readmeText)) {
    problems.push(
      "README does not state the local quality gate runs entirely offline"
    );
  }
  return problems;
}

// package.json must agree with the documented toolchain (VAL-CROSS-001).
export function toolchainProblems(pkg) {
  const problems = [];
  const range = pkg?.engines?.node;
  if (typeof range !== "string" || !satisfiesRange(NODE_MAJOR_PROBE, range)) {
    problems.push(
      `package.json engines.node "${range}" does not cover the documented Node 24`
    );
  }
  const manager = pkg?.packageManager ?? "";
  if (!manager.startsWith(PNPM_VERSION_PREFIX)) {
    problems.push(
      `package.json packageManager "${manager}" does not pin the documented pnpm 11.9.0`
    );
  }
  return problems;
}

// Lines that demand a credential on the setup/validation path (VAL-CROSS-001).
export function credentialDemands(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => CREDENTIAL_DEMAND.test(line));
}

// "doc: pnpm <token>" pairs for advertised commands with no root script.
export function advertisedCommandProblems(docs, scripts) {
  return docs.flatMap(({ doc, text }) =>
    pnpmTokens(text)
      .filter((token) => !scripts.has(token))
      .map((token) => `${doc}: pnpm ${token}`)
  );
}

const ENV_ASSIGNMENT = /^[A-Z_][A-Z0-9_]*=\S+$/;
const WHITESPACE = /\s+/;
const PNPM_LEADING = new Set(["pnpm", "corepack"]);
const BIN_DIR = join("node_modules", ".bin");

// One `&&` segment of a gate script: pnpm/corepack built-ins are fine, `node
// <file>` needs the file, anything else must be a binary the install linked.
function segmentProblems(name, segment, exists) {
  const tokens = segment
    .trim()
    .split(WHITESPACE)
    .filter((token) => !ENV_ASSIGNMENT.test(token));
  const first = tokens[0] ?? "";
  if (first === "" || PNPM_LEADING.has(first)) {
    return [];
  }
  if (first === "node") {
    const file = tokens[1];
    if (file && !file.startsWith("-") && !exists(file)) {
      return [`${name}: node script missing: ${file}`];
    }
    return [];
  }
  if (!exists(join(BIN_DIR, first))) {
    return [`${name}: binary not provided by the documented install: ${first}`];
  }
  return [];
}

// Every milestone gate script must be invokable after the documented install
// alone: each segment's leading binary resolves under node_modules/.bin (or
// is a pnpm built-in / a committed node script).
export function gateInvokabilityProblems(scripts, exists) {
  const problems = [];
  for (const name of GATE_SCRIPTS) {
    const command = scripts?.[name];
    if (typeof command !== "string") {
      problems.push(`missing gate script: ${name}`);
      continue;
    }
    for (const segment of command.split("&&")) {
      problems.push(...segmentProblems(name, segment, exists));
    }
  }
  return problems;
}

// Transcript hygiene for the fresh-checkout harness (VAL-CROSS-001). CI=1
// turns interactive prompts into hard errors, so these markers in any
// captured transcript fail the run.
const CREDENTIAL_MARKER =
  /npm login|pnpm login|npm adduser|_authToken|username:|password:|ERR_PNPM_FETCH_40[13]|E401|E403/i;

// Production endpoints the local setup/gates must never contact: production
// Worker hosts, the live Telegram API, and hosted LLM providers. The npm
// registry is the documented package manager, not a repository endpoint.
const PRODUCTION_ENDPOINT =
  /workers\.dev|api\.telegram\.org|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/i;

// Credential-prompt / production-endpoint problems in a captured transcript.
export function transcriptProblems(label, transcript) {
  const problems = [];
  if (CREDENTIAL_MARKER.test(transcript)) {
    problems.push(`${label}: transcript shows a credential prompt/failure`);
  }
  if (PRODUCTION_ENDPOINT.test(transcript)) {
    problems.push(`${label}: transcript references a production endpoint`);
  }
  return problems;
}

// The aggregate first-run invariant over a checkout rooted at `root`.
export function firstRunProblems(root = ".") {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const docs = readSetupDocs(root);
  const scripts = new Set(Object.keys(pkg.scripts ?? {}));
  const exists = (rel) => existsSync(join(root, rel));
  const readme = docs.find((entry) => entry.doc === README_FILE).text;
  return [
    ...setupStatementProblems(readme),
    ...toolchainProblems(pkg),
    ...docs.flatMap(({ doc, text }) =>
      credentialDemands(text).map((line) => `${doc}: ${line}`)
    ),
    ...advertisedCommandProblems(docs, scripts),
    ...gateInvokabilityProblems(pkg.scripts ?? {}, exists),
  ];
}
