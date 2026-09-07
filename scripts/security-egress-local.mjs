// Example-env placeholder and loopback-binding invariants
// (VAL-SEC-041/042), imported by scripts/security-egress-local.test.mjs.
// Static over committed files only: no network, no ports, no writes, no
// clock. Split from security-egress.mjs to stay under the 250 pure-LOC
// ceiling (scripts/file-size.test.mjs).

import { parseJsonc } from "./jsonc.mjs";

export const EXAMPLE_ENV_FILES = [
  ".env.example",
  "apps/worker-agent/.dev.vars.example",
  "examples/evals/.env.example",
];
export const WRANGLER_CONFIG_PATH = "apps/worker-agent/wrangler.jsonc";
export const WORKER_LOOPBACK_PORT = 8792;

// --- VAL-SEC-041: example env files carry placeholders only -----------------

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const SENSITIVE_KEY =
  /^(?:AI_API_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET_TOKEN|WORKER_AGENT_TUI_TOKEN)$/;
// Allowed placeholder shapes for sensitive keys: empty, an ellipsis, or a
// bracketed placeholder such as <account>.
const PLACEHOLDER_VALUE = /^(?:\.\.\.|<[^>]*>)?$/;
// High-entropy token shapes: long unbroken base64url-ish runs carrying both
// letters and digits, and the Telegram bot-token shape. Dotted versions,
// URLs, and model slugs never match.
const HIGH_ENTROPY_VALUE = /^[A-Za-z0-9_-]{24,}$/;
const TELEGRAM_TOKEN_VALUE = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;
const HAS_LETTER = /[A-Za-z]/;
const HAS_DIGIT = /\d/;

function looksLikeToken(value) {
  if (TELEGRAM_TOKEN_VALUE.test(value)) {
    return true;
  }
  return (
    HIGH_ENTROPY_VALUE.test(value) &&
    HAS_LETTER.test(value) &&
    HAS_DIGIT.test(value)
  );
}

export function exampleEnvProblems(path, source) {
  const problems = [];
  const lines = source.split("\n");
  lines.forEach((line, index) => {
    const label = `${path}:${index + 1}`;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      return;
    }
    const match = trimmed.match(ASSIGNMENT);
    if (!match) {
      problems.push(`${label} is not a KEY=value assignment or comment`);
      return;
    }
    const [, key, value] = match;
    if (SENSITIVE_KEY.test(key) && !PLACEHOLDER_VALUE.test(value)) {
      problems.push(
        `${label} gives sensitive key ${key} a non-placeholder value; example files carry placeholders only`
      );
    }
    if (looksLikeToken(value)) {
      problems.push(
        `${label} value for ${key} matches a high-entropy token pattern; example files carry placeholders only`
      );
    }
  });
  return problems;
}

// --- VAL-SEC-042: local validation uses only loopback port 8792 -------------

// Built at runtime so this scanner's own source never carries the literal
// non-loopback bind address it forbids (the shipped-tree scan covers this
// file too).
const NON_LOOPBACK_ADDR = ["0", "0", "0", "0"].join(".");
const NON_LOOPBACK_BIND = new RegExp(
  `\\b${NON_LOOPBACK_ADDR.replaceAll(".", "\\.")}\\b`
);
const LISTEN_PORT = /\.listen\(\s*(\d{2,5})/g;
const PORT_FLAG = /--port[ =](\d{2,5})/g;
const HOST_FLAG = /--(?:ip|host)[ =]([^\s"']+)/g;
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isLoopbackHost(host) {
  return host === "localhost" || host === "[::1]" || IPV4_LOOPBACK.test(host);
}

function devBindingProblems(label, dev) {
  const problems = [];
  if (
    dev.ip !== undefined &&
    dev.ip !== "127.0.0.1" &&
    dev.ip !== "localhost"
  ) {
    problems.push(`${label} binds dev.ip ${dev.ip}; only 127.0.0.1 is allowed`);
  }
  if (dev.port !== undefined && dev.port !== WORKER_LOOPBACK_PORT) {
    problems.push(
      `${label} binds dev.port ${dev.port}; only ${WORKER_LOOPBACK_PORT} is allowed`
    );
  }
  return problems;
}

export function wranglerBindingProblems(source) {
  const problems = [];
  if (NON_LOOPBACK_BIND.test(source)) {
    problems.push(
      `${WRANGLER_CONFIG_PATH} binds ${NON_LOOPBACK_ADDR}; loopback only`
    );
  }
  let config;
  try {
    config = parseJsonc(source);
  } catch (error) {
    return [
      ...problems,
      `${WRANGLER_CONFIG_PATH} parse error: ${error.message}`,
    ];
  }
  const dev = config?.dev;
  if (!dev || typeof dev !== "object") {
    problems.push(`${WRANGLER_CONFIG_PATH} has no dev binding block`);
    return problems;
  }
  if (dev.ip !== "127.0.0.1") {
    problems.push(
      `${WRANGLER_CONFIG_PATH} dev.ip must be 127.0.0.1, found ${dev.ip}`
    );
  }
  if (dev.port !== WORKER_LOOPBACK_PORT) {
    problems.push(
      `${WRANGLER_CONFIG_PATH} dev.port must be ${WORKER_LOOPBACK_PORT}, found ${dev.port}`
    );
  }
  for (const [name, env] of Object.entries(config?.env ?? {})) {
    if (env?.dev && typeof env.dev === "object") {
      problems.push(...devBindingProblems(`env.${name}.dev`, env.dev));
    }
  }
  return problems;
}

// Scripts must never bind a non-loopback address or open a different
// listening port. Fixture strings inside *.test.mjs are exempt from the
// port-argument rules (they feed other invariants' negative cases) but never
// from the non-loopback-address ban.
export function nonLoopbackProblems(path, source) {
  return NON_LOOPBACK_BIND.test(source)
    ? [
        `${path} references ${NON_LOOPBACK_ADDR}; local validation binds loopback only`,
      ]
    : [];
}

export function scriptPortProblems(path, source) {
  const problems = [...nonLoopbackProblems(path, source)];
  for (const match of source.matchAll(LISTEN_PORT)) {
    if (Number(match[1]) !== WORKER_LOOPBACK_PORT) {
      problems.push(
        `${path} listens on port ${match[1]}; only ${WORKER_LOOPBACK_PORT} is allowed`
      );
    }
  }
  for (const match of source.matchAll(PORT_FLAG)) {
    if (Number(match[1]) !== WORKER_LOOPBACK_PORT) {
      problems.push(
        `${path} passes --port ${match[1]}; only ${WORKER_LOOPBACK_PORT} is allowed`
      );
    }
  }
  for (const match of source.matchAll(HOST_FLAG)) {
    const host = match[1].replace(/[[\]]/g, "");
    if (!isLoopbackHost(host)) {
      problems.push(
        `${path} passes a non-loopback address ${match[1]} to an ip/host flag; loopback only`
      );
    }
  }
  return problems;
}
