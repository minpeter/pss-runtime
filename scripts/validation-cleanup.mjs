// Post-run cleanup inventory logic (VAL-CROSS-013), shared by the live
// harness (scripts/check-validation-cleanup.mjs) and the fixture proofs in
// scripts/validation-cleanup.test.mjs. Pure functions over captured
// `ss -tlnp`, `ps`, and `git status --porcelain` text: no network, no ports,
// no writes, no clock.

import { OFF_LIMITS_PORTS } from "./governance-runbooks.mjs";

// Listening ports owned by validation tooling: the local Worker and the
// loopback egress recorder. A post-run listener on one of these that was not
// in the baseline snapshot is a leaked validator by definition.
export const VALIDATOR_PORTS = [8792, 8793];

// Command-line markers of validator-spawned processes: the Wrangler dev
// server and its workerd child, the egress recorder, and the TUI visual-QA
// harness together with the coding-agent preview entrypoint it drives.
export const VALIDATOR_PROCESS_MARKERS = [
  "wrangler",
  "workerd",
  "dev:recorder",
  "loopback-recorder",
  "web-terminal-visual-qa",
  "preview-assistant-render",
];
// Matching is segment-bounded (start, whitespace, or `/` before; whitespace,
// `.`, `/`, or end after) so a command line that merely embeds a marker in a
// longer token (e.g. a shell wrapper carrying a fixture name like
// `pss-fake-wrangler`) is never mistaken for a validator.
const MARKER_PATTERNS = VALIDATOR_PROCESS_MARKERS.map(
  (marker) => new RegExp(`(?:^|[\\s/])${marker}(?:[\\s./]|$)`)
);

const LISTEN_ROW = /\bLISTEN\b/;
const LOCAL_ENDPOINT = /^(\S+):(\d+)$/;
const PROCESS_ATTRIBUTION = /users:\(\("([^"]+)",pid=(\d+)/;
const WHITESPACE = /\s+/;
const UNTRACKED_ROW = /^\?\?\s+(.*)$/;
const PID_ARGS_ROW = /^\s*(\d+)\s+(.*)$/;
const KILL_PRIMITIVES = [
  /\bprocess\.kill\s*\(/,
  /\.\s*kill\s*\(/,
  /\bpkill\b/,
  /\bkillall\b/,
  /\bkill\s+-[A-Za-z0-9]/,
];
const NETWORK_PRIMITIVES = [/node:net/, /node:http/, /\bfetch\s*\(/];
const HARNESS_SNIPPETS = [
  [/spawnSync/, "captures inventories via spawnSync"],
  [/"--baseline"/, "requires a --baseline snapshot for the check"],
  [/"--out"/, "writes evidence only under --out"],
  [/timeout:/, "bounds every spawned command with a timeout"],
];

// One `ss -tlnp` row: LISTEN state, a local `address:port` endpoint, and
// optional process attribution. Peer endpoints end in `*` and never match.
export function parseListeners(ssText) {
  const listeners = [];
  for (const line of ssText.split("\n")) {
    if (!LISTEN_ROW.test(line)) {
      continue;
    }
    const endpoint = line
      .trim()
      .split(WHITESPACE)
      .map((token) => LOCAL_ENDPOINT.exec(token))
      .find(Boolean);
    if (!endpoint) {
      continue;
    }
    const attribution = PROCESS_ATTRIBUTION.exec(line);
    listeners.push({
      address: endpoint[1],
      port: Number(endpoint[2]),
      processName: attribution?.[1] ?? null,
      pid: attribution ? Number(attribution[2]) : null,
    });
  }
  return listeners;
}

// `ps -eo pid=,args=` rows whose command line carries a validator marker.
export function validatorProcesses(psText) {
  const found = [];
  for (const line of psText.split("\n")) {
    const row = PID_ARGS_ROW.exec(line);
    if (row && MARKER_PATTERNS.some((pattern) => pattern.test(row[2]))) {
      found.push({ pid: Number(row[1]), command: row[2] });
    }
  }
  return found;
}

function listenerKey(listener) {
  return `${listener.address}:${listener.port}`;
}

function describe(listener) {
  const owner =
    listener.pid === null
      ? "unattributed"
      : `pid ${listener.pid} (${listener.processName})`;
  return `${listenerKey(listener)} owned by ${owner}`;
}

// The post-run diff: only validator-attributable leaks are problems. Foreign
// listener churn (pre-existing user processes binding ephemeral ports) is
// recorded as informational and never flagged, because a validator neither
// owns nor may terminate it.
export function inventoryProblems(baseline, current) {
  const problems = [];
  const foreignChurn = [];
  const baselineKeys = new Set(baseline.listeners.map(listenerKey));
  const baselinePids = new Set(baseline.processes.map((proc) => proc.pid));
  const newValidators = current.processes.filter(
    (proc) => !baselinePids.has(proc.pid)
  );
  const newValidatorPids = new Set(newValidators.map((proc) => proc.pid));
  for (const listener of current.listeners) {
    if (baselineKeys.has(listenerKey(listener))) {
      continue;
    }
    if (VALIDATOR_PORTS.includes(listener.port)) {
      problems.push(`leaked validator listener on ${describe(listener)}`);
    } else if (OFF_LIMITS_PORTS.includes(String(listener.port))) {
      problems.push(
        `new listener on off-limits port ${listener.port}: ${describe(listener)}`
      );
    } else if (listener.pid !== null && newValidatorPids.has(listener.pid)) {
      problems.push(
        `leaked validator process pid ${listener.pid} holds listener ${listenerKey(listener)}`
      );
    } else {
      foreignChurn.push(listener);
    }
  }
  for (const proc of newValidators) {
    problems.push(
      `leaked validator process: pid ${proc.pid} (${proc.command})`
    );
  }
  return { problems, foreignChurn };
}

// Untracked, non-ignored paths in `git status --porcelain` output: temporary
// fixtures that were neither removed nor ignored. Tracked modifications are
// feature work, not cleanup state.
export function untrackedArtifacts(porcelainText) {
  return porcelainText
    .split("\n")
    .map((line) => UNTRACKED_ROW.exec(line)?.[1])
    .filter(Boolean);
}

// The harness source contract: observe-only (no kill primitive, no network),
// baseline-driven, timeout-bounded, evidence under --out.
export function harnessProblems(source) {
  const problems = [];
  for (const [pattern, label] of HARNESS_SNIPPETS) {
    if (!pattern.test(source)) {
      problems.push(`check-validation-cleanup no longer ${label}`);
    }
  }
  for (const pattern of KILL_PRIMITIVES) {
    if (pattern.test(source)) {
      problems.push(
        `check-validation-cleanup contains a kill primitive (${pattern}); the check is observe-only`
      );
    }
  }
  for (const pattern of NETWORK_PRIMITIVES) {
    if (pattern.test(source)) {
      problems.push(
        `check-validation-cleanup contains a network primitive (${pattern})`
      );
    }
  }
  return problems;
}
