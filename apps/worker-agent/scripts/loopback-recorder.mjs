#!/usr/bin/env node
// Loopback egress recorder for local Worker validation (zero-egress proofs).
//
// Point AI_BASE_URL or TELEGRAM_API_BASE_URL at this server during local
// probes: every inbound request is appended to a JSONL log and answered with
// a canned OK payload (a superset that satisfies both the Telegram Bot API
// getMe/sendMessage shapes and a generic JSON consumer). The proof is the log
// contents afterwards — for read-only probes it must have zero entries.
//
// Usage:
//   node apps/worker-agent/scripts/loopback-recorder.mjs --port 8793 --log <file>
//
// Loopback only (127.0.0.1); validation tooling, never a production service.

import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";

const BODY_PREVIEW_MAX = 200;

function parseArgs(argv) {
  const args = { log: undefined, port: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--port" || key === "--log") {
      args[key.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  const port = Number.parseInt(args.port ?? "", 10);
  if (!(Number.isInteger(port) && port > 0 && port < 65_536)) {
    throw new Error("--port <1-65535> is required");
  }
  if (!args.log) {
    throw new Error("--log <file> is required");
  }
  return { logPath: resolve(args.log), port };
}

async function readBodyPreview(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > BODY_PREVIEW_MAX * 2) {
      break;
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length <= BODY_PREVIEW_MAX
    ? text
    : `${text.slice(0, BODY_PREVIEW_MAX)}...`;
}

const CANNED_OK = JSON.stringify({
  ok: true,
  result: {
    chat: { id: 0, type: "private" },
    date: 0,
    first_name: "Recorder",
    id: 0,
    is_bot: true,
    message_id: 1,
    username: "placeholder_bot",
  },
});

function main() {
  const { logPath, port } = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(logPath), { recursive: true });

  const server = createServer((request, response) => {
    readBodyPreview(request)
      .then((bodyPreview) => {
        appendFileSync(
          logPath,
          `${JSON.stringify({
            bodyPreview,
            method: request.method,
            ts: new Date().toISOString(),
            url: request.url,
          })}\n`
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(CANNED_OK);
      })
      .catch(() => {
        response.writeHead(500);
        response.end();
      });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`loopback-recorder listening on 127.0.0.1:${port}`);
    console.log(`logging to ${logPath}`);
  });
}

main();
