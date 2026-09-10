#!/usr/bin/env node
// worker-api-contract-diff — bidirectional diff and auth-matrix checks for
// the Worker OpenAPI contract gate (VAL-WORKER-029/030). Parsing and path
// matching live in scripts/worker-api-contract.mjs.

import {
  BEARER_SCHEME,
  HEALTH_PATH,
  matchDocumentedPath,
  recordCovered,
  WEBHOOK_SCHEME,
} from "./worker-api-contract.mjs";

const TUI_TOKEN_BINDING_PATTERN = /WORKER_AGENT_TUI_TOKEN/u;
const DEV_EXCEPTION_PATTERN = /not configured|unset/iu;
const DEVELOPMENT_PATTERN = /development/iu;
const WEBHOOK_TOKEN_BINDING_PATTERN = /TELEGRAM_WEBHOOK_SECRET_TOKEN/u;

/**
 * Bidirectional doc-vs-observations diff. Returns human-readable problem
 * lines: documented-but-unreproduced and observed-but-omitted.
 */
export function diffContract(paths, records) {
  return [
    ...paths.flatMap((entry) => documentedPathProblems(paths, entry, records)),
    ...records.flatMap((record) => observedRecordProblems(paths, record)),
  ];
}

function documentedPathProblems(paths, entry, records) {
  const problems = [];
  const matched = recordsForEntry(paths, entry, records);
  for (const operation of entry.operations) {
    const forMethod = matched.filter(
      (record) => record.method.toLowerCase() === operation.method
    );
    if (forMethod.length === 0) {
      problems.push(
        `documented-but-unreproduced: ${operation.method.toUpperCase()} ${entry.docPath} has no observed probe`
      );
    }
    for (const status of operation.statuses) {
      if (!forMethod.some((record) => record.status === status)) {
        problems.push(
          `documented-but-unreproduced: ${operation.method.toUpperCase()} ${entry.docPath} status ${status} has no observed probe`
        );
      }
    }
  }
  if (entry.rejectedStatus !== null) {
    const methods = new Set(entry.operations.map((op) => op.method));
    const rejected = matched.filter(
      (record) =>
        !methods.has(record.method.toLowerCase()) &&
        record.status === entry.rejectedStatus
    );
    if (rejected.length === 0) {
      problems.push(
        `documented-but-unreproduced: ${entry.docPath} rejected-methods status ${entry.rejectedStatus} has no observed probe`
      );
    }
  }
  return problems;
}

function observedRecordProblems(paths, record) {
  const entry = matchDocumentedPath(paths, record.path);
  if (!entry) {
    return [
      `observed-but-omitted: ${record.id} (${record.method} ${record.path}) matches no documented path`,
    ];
  }
  if (!recordCovered(entry, record)) {
    return [
      `observed-but-omitted: ${record.id} (${record.method} ${record.path} -> ${record.status}) is not documented on ${entry.docPath}`,
    ];
  }
  return [];
}

function recordsForEntry(paths, entry, records) {
  return records.filter(
    (record) => matchDocumentedPath(paths, record.path) === entry
  );
}

/** Auth truthfulness checks (VAL-WORKER-030) against doc and observations. */
export function authMatrixProblems(paths, records, rawText) {
  const problems = [];
  checkHealthAuth(paths, records, problems);
  checkBearerAuth(paths, records, problems);
  checkWebhookAuth(paths, records, problems);
  if (!TUI_TOKEN_BINDING_PATTERN.test(rawText)) {
    problems.push(
      "auth: the doc never names the WORKER_AGENT_TUI_TOKEN binding"
    );
  }
  if (
    !(DEV_EXCEPTION_PATTERN.test(rawText) && DEVELOPMENT_PATTERN.test(rawText))
  ) {
    problems.push(
      "auth: the doc must record the development exception (open when the token is not configured)"
    );
  }
  if (!WEBHOOK_TOKEN_BINDING_PATTERN.test(rawText)) {
    problems.push(
      "auth: the doc never names the TELEGRAM_WEBHOOK_SECRET_TOKEN binding"
    );
  }
  return problems;
}

function checkHealthAuth(paths, records, problems) {
  const health = paths.find((entry) => entry.docPath === HEALTH_PATH);
  if (!health) {
    problems.push(`auth: ${HEALTH_PATH} is not documented`);
    return;
  }
  for (const operation of health.operations) {
    if (operation.security.length > 0) {
      problems.push(
        `auth: ${HEALTH_PATH} ${operation.method.toUpperCase()} must not declare a security scheme (it is unauthenticated)`
      );
    }
  }
  const healthRecords = recordsForEntry(paths, health, records);
  if (!healthRecords.some((r) => r.auth === "none" && r.status === 200)) {
    problems.push("auth: no unauthenticated 200 probe observed for /healthz");
  }
  if (healthRecords.some((r) => r.status === 401)) {
    problems.push(
      "auth: a 401 was observed on /healthz, which never authenticates"
    );
  }
}

function checkBearerAuth(paths, records, problems) {
  const bearerPaths = paths.filter((entry) =>
    entry.operations.some((op) => op.security.includes(BEARER_SCHEME))
  );
  if (bearerPaths.length === 0) {
    problems.push(`auth: no path declares the ${BEARER_SCHEME} scheme`);
  }
  for (const entry of bearerPaths) {
    const matched = recordsForEntry(paths, entry, records);
    const cases = [
      ["token", "bearer-missing", 401],
      ["token", "bearer-valid", 2],
      ["dev-open", "none", 2],
    ];
    for (const [env, auth, expected] of cases) {
      const hit = matched.some(
        (r) =>
          r.env === env &&
          r.auth === auth &&
          (expected === 2
            ? r.status >= 200 && r.status < 300
            : r.status === expected)
      );
      if (!hit) {
        problems.push(
          `auth: ${entry.docPath} lacks an observed ${env}/${auth} probe with ${expected === 2 ? "2xx" : expected}`
        );
      }
    }
  }
}

function checkWebhookAuth(paths, records, problems) {
  const catchAll = paths.find((entry) => entry.catchAll);
  if (!catchAll) {
    problems.push("auth: the Telegram webhook catch-all is not documented");
    return;
  }
  if (
    !catchAll.operations.every(
      (op) => op.security.length === 1 && op.security[0] === WEBHOOK_SCHEME
    )
  ) {
    problems.push(`auth: the catch-all must declare only ${WEBHOOK_SCHEME}`);
  }
  const matched = recordsForEntry(paths, catchAll, records);
  if (
    !matched.some(
      (r) => r.auth === "telegram-secret-missing" && r.status === 401
    )
  ) {
    problems.push("auth: no observed catch-all 401 for a missing secret token");
  }
  if (
    !matched.some(
      (r) => r.auth === "telegram-secret-invalid" && r.status === 401
    )
  ) {
    problems.push(
      "auth: no observed catch-all 401 for an invalid secret token"
    );
  }
  if (
    !matched.some((r) => r.auth === "telegram-secret-valid" && r.status !== 401)
  ) {
    problems.push(
      "auth: no observed catch-all non-401 probe with a valid secret token"
    );
  }
}

/**
 * Live-probe comparison: every live record must be a documented, committed
 * live-reproducible record with the same status, and every committed
 * live-reproducible record must be reproduced.
 */
export function diffLiveRecords(paths, committed, liveRecords) {
  const problems = [];
  const byId = new Map(committed.map((record) => [record.id, record]));
  for (const live of liveRecords) {
    const expected = byId.get(live.id);
    if (!expected) {
      problems.push(
        `observed-but-omitted: live probe ${live.id} is not committed`
      );
      continue;
    }
    if (!expected.via.includes("live")) {
      problems.push(`live probe ${live.id} is not marked live-reproducible`);
      continue;
    }
    if (live.status !== expected.status) {
      problems.push(
        `live probe ${live.id} answered ${live.status}, expected ${expected.status}`
      );
    }
    const entry = matchDocumentedPath(paths, expected.path);
    if (!(entry && recordCovered(entry, expected))) {
      problems.push(`live probe ${live.id} is not covered by the document`);
    }
  }
  for (const record of committed) {
    if (
      record.via.includes("live") &&
      !liveRecords.some((l) => l.id === record.id)
    ) {
      problems.push(
        `documented-but-unreproduced: live probe ${record.id} was not exercised`
      );
    }
  }
  return problems;
}
