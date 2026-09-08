#!/usr/bin/env node
// worker-api-contract — parsing and path matching for the Worker OpenAPI
// contract gate (VAL-WORKER-029/030). Parses
// docs/worker-api-contract.openapi.yaml and the observed-behavior records in
// docs/worker-api-contract.observations.json (pinned by
// apps/worker-agent/src/api-contract-observations.test.ts). The diff and
// auth-matrix logic lives in scripts/worker-api-contract-diff.mjs; the CLI
// wrapper in scripts/check-worker-api-contract.mjs.

import { parse } from "yaml";

export const CONTRACT_DOC_PATH = "docs/worker-api-contract.openapi.yaml";
export const OBSERVATIONS_PATH = "docs/worker-api-contract.observations.json";

export const BEARER_SCHEME = "TuiBearerToken";
export const WEBHOOK_SCHEME = "TelegramWebhookSecretToken";
export const HEALTH_PATH = "/healthz";

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);
const ENV_KINDS = new Set(["any", "broken-bindings", "dev-open", "token"]);
const AUTH_KINDS = new Set([
  "bearer-invalid",
  "bearer-missing",
  "bearer-valid",
  "none",
  "telegram-secret-invalid",
  "telegram-secret-missing",
  "telegram-secret-valid",
]);
const VIA_KINDS = new Set(["live", "unit"]);
const REGEX_SPECIAL_CHARS = /[.*+?^$()[\]\\|]/gu;
const TEMPLATE_SEGMENT = /\{[^/{}]+\}/gu;
const CATCH_ALL_PATTERN = /^\/.*$/u;

/** Parse and structurally validate the OpenAPI document. Throws on invalid. */
export function parseContractDocument(text) {
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    throw new Error(`contract document is not valid YAML: ${error.message}`);
  }
  if (!(doc && typeof doc === "object")) {
    throw new Error("contract document must be a YAML mapping");
  }
  if (!(typeof doc.openapi === "string" && doc.openapi.startsWith("3."))) {
    throw new Error("contract document must declare an OpenAPI 3.x version");
  }
  if (
    !(
      doc.info &&
      typeof doc.info.title === "string" &&
      typeof doc.info.version === "string"
    )
  ) {
    throw new Error(
      "contract document must declare info.title and info.version"
    );
  }
  if (!(doc.paths && typeof doc.paths === "object")) {
    throw new Error("contract document must declare paths");
  }
  const paths = [];
  for (const [docPath, entry] of Object.entries(doc.paths)) {
    paths.push(parsePathEntry(docPath, entry));
  }
  if (paths.length === 0) {
    throw new Error("contract document must document at least one path");
  }
  return { paths, raw: doc };
}

function parsePathEntry(docPath, entry) {
  if (!(entry && typeof entry === "object")) {
    throw new Error(`path ${docPath} must be a mapping`);
  }
  const aliases = entry["x-pss-path-aliases"] ?? [];
  const rejected = entry["x-pss-rejected-methods"];
  const operations = [];
  for (const [method, operation] of Object.entries(entry)) {
    if (!HTTP_METHODS.has(method)) {
      continue;
    }
    if (!(operation?.responses && typeof operation.responses === "object")) {
      throw new Error(`path ${docPath} ${method} must declare responses`);
    }
    const statuses = Object.keys(operation.responses).map((key) => {
      const status = Number(key);
      if (!(Number.isInteger(status) && status >= 100 && status <= 599)) {
        throw new Error(
          `path ${docPath} ${method} has a non-numeric status ${key}`
        );
      }
      return status;
    });
    if (statuses.length === 0) {
      throw new Error(`path ${docPath} ${method} must document a status`);
    }
    const security = (operation.security ?? []).map((requirement) => {
      const names = Object.keys(requirement);
      if (names.length !== 1) {
        throw new Error(
          `path ${docPath} ${method} has an invalid security requirement`
        );
      }
      return names[0];
    });
    operations.push({ method, security, statuses });
  }
  if (operations.length === 0) {
    throw new Error(`path ${docPath} must document at least one operation`);
  }
  return {
    aliases,
    catchAll: entry["x-pss-match"] === "catchall",
    docPath,
    operations,
    rejectedStatus:
      rejected && typeof rejected === "object" ? rejected.status : null,
    templated: docPath.includes("{"),
  };
}

/** Parse and validate the observed-behavior records JSON. Throws on invalid. */
export function parseObservations(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`observations file is not valid JSON: ${error.message}`);
  }
  const records = parsed?.records;
  if (!Array.isArray(records)) {
    throw new Error("observations file must declare a records array");
  }
  const seen = new Set();
  for (const record of records) {
    const problem = recordProblem(record, seen);
    if (problem) {
      throw new Error(`observation ${record?.id ?? "?"}: ${problem}`);
    }
  }
  return records;
}

function recordProblem(record, seen) {
  if (!(record && typeof record === "object")) {
    return "must be an object";
  }
  if (!(typeof record.id === "string" && record.id.length > 0)) {
    return "missing id";
  }
  if (seen.has(record.id)) {
    return "duplicate id";
  }
  seen.add(record.id);
  if (!ENV_KINDS.has(record.env)) {
    return `unknown env ${record.env}`;
  }
  if (
    !(
      typeof record.method === "string" &&
      record.method === record.method.toUpperCase()
    )
  ) {
    return `method must be uppercase, got ${record.method}`;
  }
  if (!(typeof record.path === "string" && record.path.startsWith("/"))) {
    return `path must start with /, got ${record.path}`;
  }
  if (!AUTH_KINDS.has(record.auth)) {
    return `unknown auth ${record.auth}`;
  }
  if (
    !(
      Number.isInteger(record.status) &&
      record.status >= 100 &&
      record.status <= 599
    )
  ) {
    return `invalid status ${record.status}`;
  }
  if (
    !(
      Array.isArray(record.via) &&
      record.via.length > 0 &&
      record.via.every((via) => VIA_KINDS.has(via))
    )
  ) {
    return "via must be a non-empty subset of [unit, live]";
  }
  return null;
}

/** Match an observed pathname to a documented path entry, or null. */
export function matchDocumentedPath(paths, observedPath) {
  for (const entry of paths) {
    if (entry.templated || entry.catchAll) {
      continue;
    }
    if (
      entry.docPath === observedPath ||
      entry.aliases.includes(observedPath)
    ) {
      return entry;
    }
  }
  for (const entry of paths) {
    if (!(entry.templated || entry.catchAll)) {
      continue;
    }
    if (pathEntryPattern(entry).test(observedPath)) {
      return entry;
    }
  }
  return null;
}

function pathEntryPattern(entry) {
  if (entry.catchAll) {
    return CATCH_ALL_PATTERN;
  }
  const source = entry.docPath
    .replace(REGEX_SPECIAL_CHARS, "\\$&")
    .replace(TEMPLATE_SEGMENT, "[^/]+");
  return new RegExp(`^${source}$`, "u");
}

/** True when the record's (method, status) is covered by the path entry. */
export function recordCovered(entry, record) {
  const method = record.method.toLowerCase();
  const operation = entry.operations.find((op) => op.method === method);
  if (operation) {
    return operation.statuses.includes(record.status);
  }
  return entry.rejectedStatus === record.status;
}
