import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "./env";
import worker from "./index";

/**
 * Pins docs/worker-api-contract.observations.json to the actual route
 * behavior: every record marked `via: ["unit", ...]` is replayed through
 * `worker.fetch` with a mocked Durable Object layer and must answer the
 * recorded status. Records marked live-only (for example the tui.turn model
 * failure) are reproduced by the wrangler-dev probe battery instead.
 */

const WORKER_ORIGIN = "http://worker.local";
const TUI_TOKEN = "probe-tui-token";
const WEBHOOK_SECRET = "probe-webhook-secret";
const OBSERVATIONS_PATH = "../../../docs/worker-api-contract.observations.json";

const VALID_CHANNEL = { id: "local", kind: "tui" } as const;
const SSE_CHANNEL_QUERY = "channel=tui%3Alocal";
const REPLAY_INPUT = JSON.stringify({ channel: VALID_CHANNEL });
const SUBMIT_BODY = { channel: VALID_CHANNEL, text: "hello" };

type DoMode = "fail" | "rpc" | "sse" | "undefined";

const durableObjectMock = vi.hoisted((): { mode: DoMode } => ({ mode: "rpc" }));

vi.mock("@minpeter/pss-runtime/platform/durable-object/cloudflare", () => ({
  fetchCloudflareDurableObject: (options: { request: Request }) => {
    if (durableObjectMock.mode === "fail") {
      return Promise.reject(new Error("durable object unreachable"));
    }
    if (durableObjectMock.mode === "undefined") {
      return Promise.resolve(undefined);
    }
    const pathname = new URL(options.request.url).pathname;
    if (pathname === "/session/events") {
      return Promise.resolve(
        new Response('event: thread-event\ndata: {"cursor":{"offset":0}}\n\n', {
          headers: { "content-type": "text/event-stream; charset=utf-8" },
          status: 200,
        })
      );
    }
    if (pathname === "/session/events/replay") {
      return Promise.resolve(Response.json({ events: [] }));
    }
    if (pathname === "/session/turn") {
      return Promise.resolve(
        Response.json({ accepted: true, runId: "run-1", threadKey: "default" })
      );
    }
    return Promise.resolve(Response.json({ delivered: true, messages: [] }));
  },
}));

interface ContractObservation {
  readonly auth: string;
  readonly env: string;
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly via: readonly string[];
}

interface ProbeRequest {
  readonly body?: string;
  readonly contentType?: string;
  readonly doMode?: DoMode;
  readonly query?: string;
}

const replayQuery = `input=${encodeURIComponent(REPLAY_INPUT)}`;
const jsonPost = (body: unknown): ProbeRequest => ({
  body: JSON.stringify(body),
  contentType: "application/json",
});

/** Request mechanics per unit-reproducible record id. */
const PROBE_REQUESTS: Record<string, ProbeRequest> = {
  "health-get": {},
  "health-get-trailing-slash": {},
  "health-post": {},
  "health-unavailable": {},
  "replay-events-do-unavailable": { doMode: "fail", query: replayQuery },
  "replay-events-get-authorized": { query: replayQuery },
  "replay-events-get-dev-open": { query: replayQuery },
  "replay-events-get-unauthorized": { query: replayQuery },
  "replay-events-invalid-input": {
    query: `input=${encodeURIComponent(JSON.stringify({ channel: VALID_CHANNEL, limit: 0 }))}`,
  },
  "replay-events-post": jsonPost({ channel: VALID_CHANNEL }),
  "sse-do-unavailable": { doMode: "fail", query: SSE_CHANNEL_QUERY },
  "sse-get-authorized": { doMode: "sse", query: SSE_CHANNEL_QUERY },
  "sse-get-dev-open": { doMode: "sse", query: SSE_CHANNEL_QUERY },
  "sse-get-unauthorized": { query: SSE_CHANNEL_QUERY },
  "sse-invalid-channel": { query: "channel=local" },
  "sse-missing-channel": {},
  "sse-post": {},
  "submit-turn-do-unavailable": { doMode: "fail", ...jsonPost(SUBMIT_BODY) },
  "submit-turn-get": {},
  "submit-turn-invalid-input": jsonPost({ channel: VALID_CHANNEL }),
  "submit-turn-non-json-post": { body: "hello", contentType: "text/plain" },
  "submit-turn-post-authorized": jsonPost(SUBMIT_BODY),
  "submit-turn-post-dev-open": jsonPost(SUBMIT_BODY),
  "submit-turn-post-unauthorized": jsonPost(SUBMIT_BODY),
  "trpc-root-get": {},
  "trpc-unknown-get": {},
  "trpc-unknown-get-authorized": {},
  "trpc-unknown-post": jsonPost({ json: {} }),
  "tui-turn-do-rejected": { doMode: "fail", ...jsonPost(SUBMIT_BODY) },
  "tui-turn-do-unavailable": { doMode: "undefined", ...jsonPost(SUBMIT_BODY) },
  "tui-turn-get": {},
  "tui-turn-invalid-input": jsonPost({ channel: VALID_CHANNEL }),
  "tui-turn-non-json-post": { body: "hello", contentType: "text/plain" },
  "tui-turn-post-authorized": jsonPost(SUBMIT_BODY),
  "tui-turn-post-dev-open": jsonPost(SUBMIT_BODY),
  "tui-turn-post-unauthorized": jsonPost(SUBMIT_BODY),
  "webhook-healthz-subpath-missing-secret": {},
  "webhook-root-missing-secret": {},
  "webhook-telegram-invalid-secret": jsonPost({}),
  "webhook-telegram-missing-secret": jsonPost({}),
  "webhook-telegram-valid-secret-get": {},
  "webhook-telegram-valid-secret-invalid-json": {
    body: "this is not json",
    contentType: "application/json",
  },
  "webhook-telegram-valid-secret-post": jsonPost({}),
};

const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext;

function createEnv(profile: string): Env {
  const base = {
    AGENT_DO: { get: () => ({}) },
    AI_API_KEY: "probe-placeholder",
    AI_BASE_URL: "http://127.0.0.1:9/unreachable",
    AI_MODEL: "probe-model",
    ENVIRONMENT: "development",
    TELEGRAM_BOT_TOKEN: "probe-placeholder",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: WEBHOOK_SECRET,
    WORKER_AGENT_TUI_TOKEN: TUI_TOKEN,
  };
  if (profile === "dev-open") {
    const { WORKER_AGENT_TUI_TOKEN: _omitted, ...rest } = base;
    return rest as unknown as Env;
  }
  if (profile === "broken-bindings") {
    return { ...base, AGENT_DO: {} } as unknown as Env;
  }
  return base as unknown as Env;
}

function headersFor(auth: string): Record<string, string> {
  switch (auth) {
    case "bearer-invalid":
      return { authorization: `Bearer wrong-${TUI_TOKEN}` };
    case "bearer-valid":
      return { authorization: `Bearer ${TUI_TOKEN}` };
    case "telegram-secret-invalid":
      return { "x-telegram-bot-api-secret-token": `wrong-${WEBHOOK_SECRET}` };
    case "telegram-secret-valid":
      return { "x-telegram-bot-api-secret-token": WEBHOOK_SECRET };
    default:
      return {};
  }
}

function loadObservations(): ContractObservation[] {
  const url = new URL(OBSERVATIONS_PATH, import.meta.url);
  const parsed = JSON.parse(readFileSync(url, "utf8")) as {
    readonly records: ContractObservation[];
  };
  return parsed.records;
}

describe("worker api contract observations", () => {
  beforeEach(() => {
    durableObjectMock.mode = "rpc";
    // Block the Telegram adapter's initialization getMe egress.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("NetworkError: egress blocked")))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pins every unit-reproducible record to the observed status", async () => {
    const records = loadObservations();
    const unitRecords = records.filter((record) => record.via.includes("unit"));
    expect(
      unitRecords.map((record) => record.id).sort(),
      "every unit record needs probe mechanics and vice versa"
    ).toEqual(Object.keys(PROBE_REQUESTS).sort());

    const mismatches: string[] = [];
    for (const record of unitRecords) {
      const spec = PROBE_REQUESTS[record.id];
      if (!spec) {
        mismatches.push(`${record.id}: missing probe mechanics`);
        continue;
      }
      durableObjectMock.mode = spec.doMode ?? "rpc";
      const query = spec.query ? `?${spec.query}` : "";
      const headers: Record<string, string> = { ...headersFor(record.auth) };
      if (spec.contentType) {
        headers["content-type"] = spec.contentType;
      }
      const response = await worker.fetch(
        new Request(`${WORKER_ORIGIN}${record.path}${query}`, {
          body: spec.body,
          headers,
          method: record.method,
        }),
        createEnv(record.env),
        ctx
      );
      if (response.status !== record.status) {
        mismatches.push(
          `${record.id}: ${record.method} ${record.path} answered ${response.status}, expected ${record.status}`
        );
      }
      await response.body?.cancel();
    }
    expect(mismatches).toEqual([]);
  });

  it("keeps live-only records out of the unit probe table", () => {
    const records = loadObservations();
    const liveOnly = records.filter((record) => !record.via.includes("unit"));
    expect(liveOnly.map((record) => record.id).sort()).toEqual([
      "tui-turn-dev-open-model-failure",
      "tui-turn-model-failure",
    ]);
    for (const record of liveOnly) {
      expect(PROBE_REQUESTS[record.id]).toBeUndefined();
    }
  });
});
