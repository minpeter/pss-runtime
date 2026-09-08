// TUI visual-QA harness agreement invariants (VAL-CROSS-012), imported by
// scripts/tui-qa-harness.test.mjs. The xterm.js harness at
// script/qa/web-terminal-visual-qa.mjs must keep its no-new-service shape
// (an ephemeral loopback page server and a headless browser that are both
// closed before exit, receipts written into the evidence dir, no credential
// env), and the CONTRIBUTING QA guidance must document the concrete fixture
// — entrypoint, state marker, evidence root — that the live probe runs.
// Static over committed files plus `git check-ignore`: no network, no ports,
// no writes.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gitIgnoredPaths } from "./governance-contributing.mjs";

export const HARNESS = "script/qa/web-terminal-visual-qa.mjs";
export const CONTRIBUTING = "CONTRIBUTING.md";
export const CLI_PACKAGE = "apps/coding-agent/package.json";
export const PREVIEW_ENTRYPOINT =
  "apps/coding-agent/scripts/preview-assistant-render.ts";
export const PREVIEW_COMMAND = "preview:assistant";
export const EVIDENCE_ROOT = ".omo/evidence/";
export const QA_META_MARKER = "__PSS_QA_META__";
// The documented state: the preview entrypoint prints this banner and the
// docs name it, so a harness transcript can be tied to the documented
// screen.
export const STATE_MARKER = "assistant renderer preview";
// Probed evidence path used to prove the evidence tree stays gitignored.
export const EVIDENCE_PROBE = `${EVIDENCE_ROOT}tui-qa/qa-result.json`;

// The page server must bind an ephemeral port (0) on loopback only; a fixed
// port would be a new service the harness leaves contention with.
const EPHEMERAL_LOOPBACK_LISTEN = /server\.listen\(0, "127\.0\.0\.1"/;
const LISTEN_CALL = /\.listen\(\s*(\d+)/g;
// Credential-shaped env keys must never appear in the harness: the probe
// needs no provider key, token, secret, or password.
const CREDENTIAL_KEY =
  /\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\b/;

const REQUIRED_SNIPPETS = [
  { label: "closes the page server", pattern: /server\.close\(/ },
  { label: "closes the browser", pattern: /browser\.close\(\)/ },
  { label: "closes the browser server", pattern: /browserServer\.close\(/ },
  { label: "tears down in a finally block", pattern: /\bfinally\b/ },
  { label: "writes the teardown.json receipt", pattern: /teardown\.json/ },
  { label: "writes the qa-result.json receipt", pattern: /qa-result\.json/ },
  { label: "requires the --evidence-dir argument", pattern: /"evidence-dir"/ },
  {
    label: "gates the pass verdict on clean teardown",
    pattern: /Object\.values\(teardown\)\.every\(Boolean\)/,
  },
  { label: "injects the theme foreground env", pattern: /PSS_TUI_FOREGROUND/ },
];

function read(root, path) {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}

// The harness keeps its no-new-service shape: ephemeral loopback listener
// only, full teardown recorded, evidence-dir required, no credential env.
export function harnessProblems(source) {
  if (typeof source !== "string") {
    return [`${HARNESS} is missing`];
  }
  const problems = [];
  if (!EPHEMERAL_LOOPBACK_LISTEN.test(source)) {
    problems.push(
      `${HARNESS} no longer binds its page server to an ephemeral loopback port`
    );
  }
  for (const match of source.matchAll(LISTEN_CALL)) {
    if (Number(match[1]) !== 0) {
      problems.push(
        `${HARNESS} listens on fixed port ${match[1]}; only the ephemeral port 0 is allowed`
      );
    }
  }
  for (const { label, pattern } of REQUIRED_SNIPPETS) {
    if (!pattern.test(source)) {
      problems.push(`${HARNESS} no longer ${label}`);
    }
  }
  const credential = CREDENTIAL_KEY.exec(source);
  if (credential !== null) {
    problems.push(
      `${HARNESS} references credential-shaped env key ${credential[0]}; the probe needs no credentials`
    );
  }
  return problems;
}

const FIXTURE_INVOCATION = `node ${HARNESS}`;
const EVIDENCE_FLAG = `--evidence-dir ${EVIDENCE_ROOT}`;
const NO_LISTENING_PORT = /no listening port/i;
const NO_CREDENTIAL = /no credential/i;

// CONTRIBUTING documents the concrete fixture: harness invocation, the
// preview entrypoint, the documented state, the evidence root, and the
// no-port / no-credential contract.
export function docsProblems(text) {
  if (typeof text !== "string") {
    return [`${CONTRIBUTING} is missing`];
  }
  const problems = [];
  if (!text.includes(FIXTURE_INVOCATION)) {
    problems.push(`${CONTRIBUTING} no longer documents the harness invocation`);
  }
  if (!text.includes(PREVIEW_COMMAND)) {
    problems.push(
      `${CONTRIBUTING} no longer names the ${PREVIEW_COMMAND} entrypoint`
    );
  }
  if (!text.includes(STATE_MARKER)) {
    problems.push(
      `${CONTRIBUTING} no longer names the documented state "${STATE_MARKER}"`
    );
  }
  if (!text.includes(EVIDENCE_FLAG)) {
    problems.push(
      `${CONTRIBUTING} no longer points harness evidence at ${EVIDENCE_ROOT}`
    );
  }
  if (!NO_LISTENING_PORT.test(text)) {
    problems.push(`${CONTRIBUTING} lost the no-listening-port contract`);
  }
  if (!NO_CREDENTIAL.test(text)) {
    problems.push(`${CONTRIBUTING} lost the no-credential contract`);
  }
  return problems;
}

// The documented entrypoint must exist as a package script backed by the
// preview module.
export function packageProblems(pkg) {
  const script = pkg?.scripts?.[PREVIEW_COMMAND];
  return typeof script === "string" &&
    script.includes("preview-assistant-render")
    ? []
    : [`${CLI_PACKAGE} lost the ${PREVIEW_COMMAND} script`];
}

// The entrypoint emits the metadata marker the harness parses and prints
// the documented state banner.
export function previewProblems(source) {
  if (typeof source !== "string") {
    return [`${PREVIEW_ENTRYPOINT} is missing`];
  }
  const problems = [];
  if (!source.includes(QA_META_MARKER)) {
    problems.push(
      `${PREVIEW_ENTRYPOINT} no longer emits the ${QA_META_MARKER} marker the harness parses`
    );
  }
  if (!source.includes(STATE_MARKER)) {
    problems.push(
      `${PREVIEW_ENTRYPOINT} no longer prints the documented state banner`
    );
  }
  return problems;
}

// Harness output lands under the gitignored evidence tree and is never
// committed.
export function evidenceIgnoreProblems(root = ".") {
  return gitIgnoredPaths([EVIDENCE_PROBE], root).has(EVIDENCE_PROBE)
    ? []
    : [`${EVIDENCE_ROOT} evidence is not gitignored`];
}

export function tuiQaHarnessProblems(root = ".") {
  const problems = [];
  problems.push(...harnessProblems(read(root, HARNESS)));
  problems.push(...docsProblems(read(root, CONTRIBUTING)));
  const pkgText = read(root, CLI_PACKAGE);
  problems.push(
    ...(pkgText === null
      ? [`${CLI_PACKAGE} is missing`]
      : packageProblems(JSON.parse(pkgText)))
  );
  problems.push(...previewProblems(read(root, PREVIEW_ENTRYPOINT)));
  problems.push(...evidenceIgnoreProblems(root));
  return problems;
}
