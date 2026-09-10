import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Invariant helpers for the devcontainer (VAL-LOCAL-008 .. VAL-LOCAL-011).
// Everything here is deterministic, offline, and decidable from committed
// repository files; Docker build evidence is captured separately.

export const DEVCONTAINER_PATH = ".devcontainer/devcontainer.json";

export const EXPECTED_NODE_MAJOR = "24";
export const EXPECTED_PNPM_VERSION = "11.9.0";

// Lifecycle keys a devcontainer may declare; only postCreateCommand is
// permitted here and it must be the frozen-lockfile install and nothing else.
const LIFECYCLE_KEYS = [
  "initializeCommand",
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "postStartCommand",
  "postAttachCommand",
];

const WHITESPACE_SPLIT = /\s+/;

// Node 24: a `node:24...` image tag, a `FROM node:24...` line, or a
// devcontainers/node feature pinned to a 24.x version.
const NODE_IMAGE_TAG =
  /node:24(?:\.\d+){0,2}(?:-[\w.]+)?(?:@sha256:[0-9a-f]{64})?/;
const NODE_FEATURE = /ghcr\.io\/devcontainers\/features\/node/;
const NODE_FEATURE_VERSION = /"version"\s*:\s*"24(?:\.\d+){0,2}"/;

// pnpm 11.9.0: an explicit pin anywhere in the devcontainer metadata or the
// referenced Dockerfile (corepack prepare / npm install -g / feature option).
const PNPM_PIN = /pnpm@11\.9\.0/;

// Host-path leakage: bind mounts with a source=, host environment
// interpolation, or a workspace mount override.
const HOST_REFERENCE =
  /\$\{localEnv:|\$\{localWorkspaceFolder\}|source\s*=|\/home\/|\/Users\/|[A-Za-z]:\\\\/;

// The lifecycle must install and stop: no test/typecheck/build/coverage,
// no TUI/Worker/watcher/server, no credential or network tooling.
const FORBIDDEN_LIFECYCLE = [
  /\b(?:test|typecheck|coverage|build|watch|serve|start)\b/,
  /\b(?:tui|worker|wrangler|turbo|dev)\b/,
  /\b(?:curl|wget)\b/,
  /https?:\/\//,
  /NPM_TOKEN/,
  /ghp_[A-Za-z0-9]{16,}/,
  /sk-[A-Za-z0-9]{16,}/,
  /npm\s+config/,
  /\/\/registry/,
];

const FROZEN_INSTALL = /^pnpm install --frozen-lockfile$/;

// Ports: the devcontainer may declare nothing, or exactly 127.0.0.1:8792.
const ALLOWED_PORT = 8792;
const PUBLISH_FLAG = /(?:^|\s)-(?:p|-publish)(?:\s|=)/;
const OFF_LIMITS_PORTS = new Set([8788, 3000, 3401, 3402]);

export function readRepoFile(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function parseDevcontainer(raw) {
  if (raw === null) {
    return { config: null, errors: [`${DEVCONTAINER_PATH} is missing`] };
  }
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return { config: null, errors: ["devcontainer.json must be an object"] };
    }
    return { config, errors: [] };
  } catch (error) {
    return { config: null, errors: [`parse error: ${error.message}`] };
  }
}

// Resolve the Dockerfile the metadata points at (default: sibling Dockerfile
// when `build.dockerfile` is set, image-only otherwise).
export function referencedDockerfile(config) {
  const dockerfile = config?.build?.dockerfile;
  if (typeof dockerfile !== "string" || dockerfile.includes("..")) {
    return null;
  }
  const path = join(dirname(DEVCONTAINER_PATH), dockerfile);
  return readRepoFile(path);
}

export function nameProblems(config) {
  if (typeof config?.name !== "string" || config.name.trim() === "") {
    return ["devcontainer.json declares no non-empty name"];
  }
  return [];
}

export function toolchainProblems(config, dockerfile) {
  const problems = [];
  const raw = JSON.stringify(config);
  const corpus = `${raw}\n${dockerfile ?? ""}`;
  const nodeOk =
    NODE_IMAGE_TAG.test(corpus) ||
    (NODE_FEATURE.test(raw) && NODE_FEATURE_VERSION.test(raw));
  if (!nodeOk) {
    problems.push("no Node 24 image, FROM line, or node feature pin found");
  }
  if (!PNPM_PIN.test(corpus)) {
    problems.push(`no pnpm@${EXPECTED_PNPM_VERSION} pin found`);
  }
  return problems;
}

export function hostPathProblems(config) {
  const problems = [];
  if (Array.isArray(config?.mounts) && config.mounts.length > 0) {
    problems.push("devcontainer declares bind mounts (host paths)");
  }
  if (typeof config?.workspaceMount === "string") {
    problems.push("devcontainer overrides workspaceMount (host path binding)");
  }
  const raw = JSON.stringify(config);
  if (HOST_REFERENCE.test(raw)) {
    problems.push("devcontainer references host paths or host environment");
  }
  return problems;
}

export function lifecycleProblems(config) {
  const problems = [];
  const declared = LIFECYCLE_KEYS.filter((key) => config?.[key] !== undefined);
  if (declared.length !== 1 || declared[0] !== "postCreateCommand") {
    problems.push(
      `lifecycle keys must be exactly [postCreateCommand], got [${declared}]`
    );
    return problems;
  }
  const command = config.postCreateCommand;
  if (typeof command !== "string") {
    problems.push("postCreateCommand must be a single string command");
    return problems;
  }
  const normalized = command.trim().split(WHITESPACE_SPLIT).join(" ");
  if (!FROZEN_INSTALL.test(normalized)) {
    problems.push(
      `postCreateCommand is not exactly 'pnpm install --frozen-lockfile': ${command}`
    );
  }
  for (const pattern of FORBIDDEN_LIFECYCLE) {
    if (pattern.test(command)) {
      problems.push(`postCreateCommand matches forbidden pattern ${pattern}`);
    }
  }
  return problems;
}

export function portProblems(config) {
  const problems = [];
  const forward = config?.forwardPorts ?? [];
  if (Array.isArray(forward)) {
    for (const port of forward) {
      const value = Number(port);
      if (value !== ALLOWED_PORT) {
        problems.push(`forwardPorts includes non-8792 port: ${port}`);
      }
      if (OFF_LIMITS_PORTS.has(value)) {
        problems.push(`forwardPorts includes off-limits port: ${port}`);
      }
    }
  } else {
    problems.push("forwardPorts must be an array when present");
  }
  if (config?.appPort !== undefined) {
    problems.push("devcontainer declares appPort");
  }
  const attributes = Object.keys(config?.portsAttributes ?? {});
  for (const key of attributes) {
    if (Number(key) !== ALLOWED_PORT) {
      problems.push(`portsAttributes declares non-8792 port: ${key}`);
    }
  }
  const runArgs = config?.runArgs ?? [];
  const joined = Array.isArray(runArgs) ? runArgs.join(" ") : String(runArgs);
  if (PUBLISH_FLAG.test(joined)) {
    problems.push("runArgs publishes a port (-p/--publish)");
  }
  return problems;
}
