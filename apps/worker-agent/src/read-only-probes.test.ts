import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "./env";
import worker from "./index";

const WORKER_ORIGIN = "http://worker.local";
const TUI_TOKEN = "probe-read-only-token";
const PROVIDER_SENTINEL_BASE = "http://127.0.0.1:8793/v1";
const SSE_CHANNEL_QUERY = "channel=tui%3Alocal";
const SSE_BODY =
  'id: 0\nevent: thread-event\ndata: {"cursor":{"offset":0},"event":{"type":"turn-start"},"threadKey":"default"}\n\n';
const HEALTH_ENVIRONMENT_PATTERN = /"environment"\s*:\s*"development"/u;
const SSE_CONTENT_TYPE_PATTERN = /text\/event-stream/u;

const ctx = {
  waitUntil() {
    // no-op: read-only probes schedule no background work
  },
};

interface RecordedEgress {
  readonly method: string;
  readonly url: string;
}

interface RecordedDurableObjectRequest {
  readonly objectName: unknown;
  readonly url: string;
}

/** Outbound recorder: ANY global fetch during a read-only probe is a failure. */
function recordEgress(outbound: RecordedEgress[]) {
  return vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : undefined;
      outbound.push({
        method: init?.method ?? request?.method ?? "GET",
        url: String(request ? request.url : input),
      });
      return Promise.resolve(
        new Response("egress blocked by read-only probe recorder", {
          status: 500,
        })
      );
    }
  );
}

/**
 * Durable Object stub that serves the canned SSE stream and replay page the
 * read-only probes need, recording every forwarded request. Both payloads are
 * committed event history — serving them never requires a model call.
 */
function createReadOnlyAgentDo(): {
  readonly forwarded: RecordedDurableObjectRequest[];
  readonly namespace: DurableObjectNamespace;
} {
  const forwarded: RecordedDurableObjectRequest[] = [];
  const namespace = {
    idFromName(name: string) {
      return `id:${name}`;
    },
    get(id: unknown) {
      return {
        fetch(request: Request) {
          const url = new URL(request.url);
          forwarded.push({
            objectName: id,
            url: `${url.pathname}${url.search}`,
          });
          if (url.pathname === "/session/events") {
            return Promise.resolve(
              new Response(SSE_BODY, {
                headers: {
                  "content-type": "text/event-stream; charset=utf-8",
                },
                status: 200,
              })
            );
          }
          if (url.pathname === "/session/events/replay") {
            return Promise.resolve(
              Response.json({
                events: [
                  {
                    cursor: { offset: 0 },
                    event: { type: "turn-start" },
                    threadKey: "default",
                  },
                ],
                nextCursor: { offset: 0 },
              })
            );
          }
          throw new Error(`unexpected Durable Object path ${url.pathname}`);
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return { forwarded, namespace };
}

function createEnv(aiApiKey: string): {
  readonly agentDo: ReturnType<typeof createReadOnlyAgentDo>;
  readonly env: Env;
} {
  const agentDo = createReadOnlyAgentDo();
  const env = {
    AGENT_DO: agentDo.namespace,
    AI_API_KEY: aiApiKey,
    AI_BASE_URL: PROVIDER_SENTINEL_BASE,
    AI_MODEL: "placeholder-model",
    ENVIRONMENT: "development",
    TELEGRAM_BOT_TOKEN: "placeholder-bot-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "placeholder_webhook_secret",
    WORKER_AGENT_TUI_TOKEN: TUI_TOKEN,
  } as unknown as Env;
  return { agentDo, env };
}

const bearer = { authorization: `Bearer ${TUI_TOKEN}` };
const replayQuery = `input=${encodeURIComponent(
  JSON.stringify({ channel: { id: "local", kind: "tui" } })
)}`;

function probe(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  return worker.fetch(
    new Request(`${WORKER_ORIGIN}${path}`, init),
    env,
    ctx as unknown as ExecutionContext
  );
}

/**
 * The full read-only battery from VAL-WORKER-041: health, SSE replay-follow
 * window, and replayEvents GET/POST (plus the auth/validation negatives).
 * Returns the observed statuses in probe order.
 */
async function runReadOnlyBattery(env: Env): Promise<Record<string, number>> {
  const statuses: Record<string, number> = {};

  const health = await probe(env, "/healthz");
  statuses.healthGet = health.status;
  expect(health.headers.get("content-type")).toContain("application/json");
  expect(await health.text()).toMatch(HEALTH_ENVIRONMENT_PATTERN);

  const healthSlash = await probe(env, "/healthz/");
  statuses.healthGetTrailingSlash = healthSlash.status;

  const healthPost = await probe(env, "/healthz", { method: "POST" });
  statuses.healthPost = healthPost.status;

  const sse = await probe(env, `/session/events?${SSE_CHANNEL_QUERY}&after=0`, {
    headers: bearer,
  });
  statuses.sseReplayFollow = sse.status;
  expect(sse.headers.get("content-type")).toMatch(SSE_CONTENT_TYPE_PATTERN);
  expect(await sse.text()).toBe(SSE_BODY);

  const sseUnauthorized = await probe(
    env,
    `/session/events?${SSE_CHANNEL_QUERY}`
  );
  statuses.sseUnauthorized = sseUnauthorized.status;

  const sseBadCursor = await probe(
    env,
    `/session/events?${SSE_CHANNEL_QUERY}&after=01`,
    { headers: bearer }
  );
  statuses.sseBadCursor = sseBadCursor.status;

  const replayGet = await probe(
    env,
    `/trpc/session.replayEvents?${replayQuery}`,
    { headers: bearer }
  );
  statuses.replayGet = replayGet.status;
  expect(await replayGet.text()).toContain('"events"');

  const replayUnauthorized = await probe(
    env,
    `/trpc/session.replayEvents?${replayQuery}`
  );
  statuses.replayGetUnauthorized = replayUnauthorized.status;

  const replayInvalid = await probe(
    env,
    `/trpc/session.replayEvents?input=${encodeURIComponent(
      JSON.stringify({ channel: { id: "local", kind: "tui" }, limit: 0 })
    )}`,
    { headers: bearer }
  );
  statuses.replayGetInvalidInput = replayInvalid.status;

  const replayPost = await probe(env, "/trpc/session.replayEvents", {
    body: JSON.stringify({ channel: { id: "local", kind: "tui" } }),
    headers: { ...bearer, "content-type": "application/json" },
    method: "POST",
  });
  statuses.replayPost = replayPost.status;

  return statuses;
}

const EXPECTED_STATUSES: Record<string, number> = {
  healthGet: 200,
  healthGetTrailingSlash: 200,
  healthPost: 405,
  replayGet: 200,
  replayGetInvalidInput: 400,
  replayGetUnauthorized: 401,
  replayPost: 405,
  sseBadCursor: 400,
  sseReplayFollow: 200,
  sseUnauthorized: 401,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("read-only probe battery (VAL-WORKER-041/042)", () => {
  it.each([
    ["placeholder-shaped key", "sk-placeholder-read-only"],
    ["invalid key", "definitely-not-a-valid-provider-key"],
  ])(
    "completes with expected statuses and zero outbound fetch (%s)",
    async (_label, aiApiKey) => {
      const outbound: RecordedEgress[] = [];
      vi.stubGlobal("fetch", recordEgress(outbound));
      const { agentDo, env } = createEnv(aiApiKey);

      const statuses = await runReadOnlyBattery(env);

      expect(statuses).toEqual(EXPECTED_STATUSES);
      // Zero provider (model) requests and zero Telegram API calls: the
      // recorder stayed empty for the whole battery regardless of API key.
      expect(outbound).toEqual([]);
      // Replay and SSE read committed history from the Durable Object only.
      const paths = agentDo.forwarded.map((request) => request.url);
      expect(paths).toContain("/session/events?channel=tui%3Alocal&after=0");
      expect(paths).toContain("/session/events/replay");
    }
  );

  it("never initializes the Telegram adapter during read-only probes", async () => {
    const outbound: RecordedEgress[] = [];
    vi.stubGlobal("fetch", recordEgress(outbound));
    const { env } = createEnv("sk-placeholder-read-only");

    await runReadOnlyBattery(env);

    expect(
      outbound.filter((request) => request.url.includes("telegram"))
    ).toEqual([]);
    expect(outbound).toEqual([]);
  });
});
