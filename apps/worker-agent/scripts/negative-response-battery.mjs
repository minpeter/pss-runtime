#!/usr/bin/env node
// Negative-response battery + leak audit for the local Worker (VAL-WORKER-045).
//
// Runs a fixed set of non-2xx probes against a running `wrangler dev -e dev`
// Worker (127.0.0.1:8792), captures each response's status/headers/body to
// files with curl, then audits every captured body:
//   - bounded size (<= 512 bytes),
//   - no echoed sentinel request content, bearer value, or configured secret,
//   - no stack markers (`at ...`, `.ts:<line>`, `Error: `),
//   - shape is a fixed literal body, the bounded health error JSON, or a
//     bounded tRPC error envelope.
// Writes transcript.tsv and audit.txt under --out and exits non-zero on any
// finding. Placeholder secrets only; the valid webhook secret is never sent,
// it is only audited against (and never written to disk).
//
// Usage:
//   node scripts/negative-response-battery.mjs --out <dir> \
//     [--base http://127.0.0.1:8792] --tui-token <placeholder> \
//     [--webhook-secret <placeholder>]

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const MAX_BODY_BYTES = 512;

const FIXED_LITERALS = new Set([
  "unauthorized",
  "channel required",
  "invalid session event stream",
  "method not allowed",
  "agent durable object unavailable",
  // The Telegram adapter's fixed webhook rejection body.
  "Invalid secret token",
]);

const STACK_PATTERNS = [
  /(^|\n)\s*at\s+[\w$.<>]+\s*\(/u,
  /\.ts:\d+/u,
  /\bError:\s/u,
];
const BEARER_VALUE_PATTERN = /Bearer\s+\S/u;

const SENTINELS = {
  bearer: "leak-sentinel-wrong-bearer",
  channelId: "leak-sentinel-channel-id",
  cursor: "leak-sentinel-cursor",
  extraKey: "leak-sentinel-extra-key",
  pathProbe: "leak-sentinel-long-path",
  text: "leak-sentinel-message-text",
  wrongSecret: "leak-sentinel-wrong-webhook-secret",
};

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "http://127.0.0.1:8792" },
    out: { type: "string" },
    "tui-token": { type: "string" },
    "webhook-secret": { type: "string" },
  },
  strict: true,
});

if (!(args.out && args["tui-token"])) {
  console.error("missing required --out and --tui-token arguments");
  process.exit(2);
}
// Validate before writing evidence or passing a token to curl. Accept only
// the documented local Worker origin, never credentials or URL suffixes.
let base;
try {
  const url = new URL(args.base);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "8792" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid local Worker origin");
  }
  base = url.origin;
} catch {
  console.error(
    "--base must be http://127.0.0.1:8792 with no credentials, path, query, or fragment"
  );
  process.exit(2);
}
mkdirSync(args.out, { recursive: true });
const bearer = ["-H", `Authorization: Bearer ${args["tui-token"]}`];
const wrongBearer = ["-H", `Authorization: Bearer ${SENTINELS.bearer}`];
const json = ["-H", "content-type: application/json"];
const update = JSON.stringify({
  message: {
    chat: { id: 4242, type: "private" },
    date: 1_800_000_000,
    message_id: 7,
    text: SENTINELS.text,
  },
  update_id: 900_001,
});
const replayInput = (value) =>
  `${base}/trpc/session.replayEvents?input=${encodeURIComponent(value)}`;
const badInput = JSON.stringify({
  [SENTINELS.extraKey]: 1,
  channel: { id: SENTINELS.channelId, kind: "sms" },
  limit: 0,
});
const inflatedInput = JSON.stringify({
  channel: { id: "local", kind: "tui" },
  ...Object.fromEntries(
    Array.from({ length: 50 }, (_, index) => [`padding-key-${index}`, 0])
  ),
});
const validInput = JSON.stringify({ channel: { id: "local", kind: "tui" } });

/** name → expected status + curl arguments (paths carry sentinel content). */
const PROBES = [
  [
    "health-post",
    405,
    ["-X", "POST", "--data", SENTINELS.text, `${base}/healthz`],
  ],
  [
    "sse-post",
    405,
    ["-X", "POST", ...bearer, `${base}/session/events?channel=tui%3Alocal`],
  ],
  ["sse-no-auth", 401, [`${base}/session/events?channel=tui%3Alocal`]],
  [
    "sse-wrong-bearer",
    401,
    [...wrongBearer, `${base}/session/events?channel=tui%3Alocal`],
  ],
  ["sse-no-channel", 400, [...bearer, `${base}/session/events`]],
  [
    "sse-bad-channel",
    400,
    [
      ...bearer,
      `${base}/session/events?channel=${encodeURIComponent(`web:${SENTINELS.channelId}`)}`,
    ],
  ],
  [
    "sse-bad-cursor",
    400,
    [
      ...bearer,
      `${base}/session/events?channel=tui%3Alocal&after=${SENTINELS.cursor}`,
    ],
  ],
  ["trpc-bad-input", 400, [...bearer, replayInput(badInput)]],
  ["trpc-inflated-input", 400, [...bearer, replayInput(inflatedInput)]],
  ["trpc-wrong-bearer", 401, [...wrongBearer, replayInput(validInput)]],
  [
    "trpc-unknown-procedure",
    404,
    [...bearer, `${base}/trpc/session.doesNotExist?input=%7B%7D`],
  ],
  // A 2000+ character attacker-controlled procedure path: the NOT_FOUND
  // envelope must stay bounded (fixed literal, no path echo).
  [
    "trpc-long-path-not-found",
    404,
    [
      ...bearer,
      `${base}/trpc/session.${"a".repeat(1000)}${SENTINELS.pathProbe}${"b".repeat(1000)}?input=%7B%7D`,
    ],
  ],
  [
    "trpc-query-post",
    405,
    [
      "-X",
      "POST",
      ...bearer,
      ...json,
      "--data",
      validInput,
      `${base}/trpc/session.replayEvents`,
    ],
  ],
  [
    "telegram-no-secret",
    401,
    ["-X", "POST", ...json, "--data", update, `${base}/telegram`],
  ],
  [
    "telegram-wrong-secret",
    401,
    [
      "-X",
      "POST",
      ...json,
      "-H",
      `x-telegram-bot-api-secret-token: ${SENTINELS.wrongSecret}`,
      "--data",
      update,
      `${base}/telegram`,
    ],
  ],
  ["unknown-route-get", 401, [...bearer, `${base}/definitely-not-a-route`]],
];

function classifyBody(body) {
  if (FIXED_LITERALS.has(body)) {
    return "literal";
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "unclassified";
  }
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed);
    if (
      keys.length === 1 &&
      (parsed.error === "unavailable" || parsed.error === "method not allowed")
    ) {
      return "health-json";
    }
    const envelope = parsed.error;
    if (
      envelope &&
      typeof envelope === "object" &&
      typeof envelope.message === "string" &&
      envelope.message.length <= 256 &&
      typeof envelope.code === "number" &&
      envelope.data &&
      typeof envelope.data.code === "string" &&
      typeof envelope.data.httpStatus === "number" &&
      !("stack" in envelope) &&
      !("cause" in envelope)
    ) {
      return "trpc-envelope";
    }
  }
  return "unclassified";
}

function auditBody(body) {
  const problems = [];
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_BODY_BYTES) {
    problems.push(`body is ${bytes} bytes (> ${MAX_BODY_BYTES})`);
  }
  const forbidden = [
    ...Object.values(SENTINELS),
    args["tui-token"],
    ...(args["webhook-secret"] ? [args["webhook-secret"]] : []),
  ];
  for (const [index, value] of forbidden.entries()) {
    if (value && body.includes(value)) {
      problems.push(`echoes forbidden value #${index}`);
    }
  }
  if (BEARER_VALUE_PATTERN.test(body)) {
    problems.push("echoes a bearer header value");
  }
  for (const pattern of STACK_PATTERNS) {
    if (pattern.test(body)) {
      problems.push(`carries stack marker ${pattern}`);
    }
  }
  for (const token of ["input=", "text=", "channel="]) {
    if (body.includes(token)) {
      problems.push(`echoes request token ${token}`);
    }
  }
  const shape = classifyBody(body);
  if (shape === "unclassified") {
    problems.push("body is not a fixed literal or bounded envelope");
  }
  return { problems, shape };
}

const transcript = ["probe\tstatus\texpected\tbytes\tshape\tproblems"];
let failures = 0;
for (const [name, expected, curlArgs] of PROBES) {
  const bodyPath = join(args.out, `${name}.body`);
  const headersPath = join(args.out, `${name}.headers`);
  const run = spawnSync(
    "curl",
    [
      "--disable",
      "-sS",
      "--noproxy",
      "*",
      "--max-time",
      "10",
      "-o",
      bodyPath,
      "-D",
      headersPath,
      "-w",
      "%{http_code}",
      ...curlArgs,
    ],
    { encoding: "utf8" }
  );
  if (run.status !== 0) {
    transcript.push(`${name}\tCURL-FAILED\t${expected}\t0\t-\t${run.stderr}`);
    failures += 1;
    continue;
  }
  const status = Number(run.stdout.trim());
  writeFileSync(join(args.out, `${name}.status`), `${status}\n`);
  const body = readFileSync(bodyPath, "utf8");
  const { problems, shape } = auditBody(body);
  if (status !== expected) {
    problems.push(`status ${status}, expected ${expected}`);
  }
  failures += problems.length > 0 ? 1 : 0;
  transcript.push(
    `${name}\t${status}\t${expected}\t${Buffer.byteLength(body)}\t${shape}\t${problems.join("; ") || "none"}`
  );
}

writeFileSync(join(args.out, "transcript.tsv"), `${transcript.join("\n")}\n`);
writeFileSync(
  join(args.out, "audit.txt"),
  failures === 0
    ? `negative-response battery: ${PROBES.length} probes, zero leak findings\n`
    : `negative-response battery: ${failures} probe(s) with findings\n`
);
console.log(transcript.join("\n"));
process.exit(failures === 0 ? 0 : 1);
