import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "./env";
import worker from "./index";
import { selectRequestHandler } from "./route-dispatch";

const WORKER_ORIGIN = "http://worker.local";
const SSE_CHANNEL_QUERY = "channel=tui%3Alocal";
const TRPC_NOT_FOUND_PATTERN = /"code"\s*:\s*"NOT_FOUND"/u;
const HEALTH_BODY_PATTERN = /"environment"/u;
const SSE_CONTENT_TYPE_PATTERN = /text\/event-stream/u;

const ctx = {
  waitUntil() {
    // no-op: dispatch probes schedule no background work
  },
};

interface AgentDoProbe {
  getCalls: number;
  namespace: DurableObjectNamespace;
}

/** Binding stub: any get() call proves a DO wake-up during the probe. */
function createAgentDoProbe(): AgentDoProbe {
  const probe: AgentDoProbe = {
    getCalls: 0,
    namespace: undefined as unknown as DurableObjectNamespace,
  };
  probe.namespace = {
    get() {
      probe.getCalls += 1;
      throw new Error("AGENT_DO get() must not run during this probe");
    },
  } as unknown as DurableObjectNamespace;
  return probe;
}

/** DO stub that serves a canned SSE stream and records the forwarded request. */
function createSseAgentDo(sseBody: string): {
  forwarded: { id: unknown; method: string; url: string }[];
  namespace: DurableObjectNamespace;
} {
  const forwarded: { id: unknown; method: string; url: string }[] = [];
  const namespace = {
    idFromName(name: string) {
      return `id:${name}`;
    },
    get(id: unknown) {
      return {
        fetch(request: Request) {
          forwarded.push({
            id,
            method: request.method,
            url: request.url,
          });
          return Promise.resolve(
            new Response(sseBody, {
              status: 200,
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
              },
            })
          );
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return { forwarded, namespace };
}

function createEnv(overrides: Record<string, unknown> = {}): {
  agentDo: AgentDoProbe;
  env: Env;
} {
  const agentDo = createAgentDoProbe();
  const env = {
    AGENT_DO: agentDo.namespace,
    AI_API_KEY: "placeholder-ai-key",
    AI_BASE_URL: "http://127.0.0.1:9/unreachable",
    AI_MODEL: "placeholder-model",
    ENVIRONMENT: "development",
    TELEGRAM_BOT_TOKEN: "placeholder-bot-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "placeholder_webhook_secret",
    ...overrides,
  } as unknown as Env;
  return { agentDo, env };
}

function probe(env: Env, path: string, method = "GET"): Promise<Response> {
  return worker.fetch(
    new Request(`${WORKER_ORIGIN}${path}`, { method }),
    env,
    ctx as unknown as ExecutionContext
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("selectRequestHandler", () => {
  it("routes only the exact /session/events pathname to the SSE route", () => {
    expect(selectRequestHandler("/session/events")).toBe("session-events");
    expect(selectRequestHandler("/session/events/replay")).toBe(
      "telegram-webhook"
    );
    expect(selectRequestHandler("/session/events/")).toBe("telegram-webhook");
    expect(selectRequestHandler("/session/event")).toBe("telegram-webhook");
    expect(selectRequestHandler("/session/eventsfoo")).toBe("telegram-webhook");
    expect(selectRequestHandler("/Session/Events")).toBe("telegram-webhook");
  });

  it("routes /trpc and every /trpc/* sub-path to the tRPC fetch adapter", () => {
    expect(selectRequestHandler("/trpc")).toBe("tui-rpc");
    expect(selectRequestHandler("/trpc/session.replayEvents")).toBe("tui-rpc");
    expect(selectRequestHandler("/trpc/does-not-exist")).toBe("tui-rpc");
    expect(selectRequestHandler("/trpc/")).toBe("tui-rpc");
  });

  it("does not treat /trpc lookalikes as tRPC paths", () => {
    expect(selectRequestHandler("/trpcfoo")).toBe("telegram-webhook");
    expect(selectRequestHandler("/trp")).toBe("telegram-webhook");
    expect(selectRequestHandler("/TRPC")).toBe("telegram-webhook");
  });

  it("routes only the documented health pathnames to the health route", () => {
    expect(selectRequestHandler("/healthz")).toBe("health");
    expect(selectRequestHandler("/healthz/")).toBe("health");
    expect(selectRequestHandler("/healthz/foo")).toBe("telegram-webhook");
    expect(selectRequestHandler("/healthcheck")).toBe("telegram-webhook");
  });

  it("routes every other pathname to the Telegram webhook catch-all", () => {
    expect(selectRequestHandler("/")).toBe("telegram-webhook");
    expect(selectRequestHandler("/telegram")).toBe("telegram-webhook");
    expect(selectRequestHandler("/favicon.ico")).toBe("telegram-webhook");
  });
});

describe("GET /session/events (SSE route)", () => {
  it("rejects non-GET methods with a bounded 405 before any auth or DO work", async () => {
    const { agentDo, env } = createEnv();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await probe(env, "/session/events", method);
      expect(response.status).toBe(405);
      expect(await response.text()).toContain("method not allowed");
      expect(response.headers.get("content-type")).not.toMatch(
        SSE_CONTENT_TYPE_PATTERN
      );
    }
    expect(agentDo.getCalls).toBe(0);
  });

  it("answers GET without a channel from the SSE route itself (400, no DO hop)", async () => {
    const { agentDo, env } = createEnv();
    const response = await probe(env, "/session/events");

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("channel required");
    expect(agentDo.getCalls).toBe(0);
  });

  it("forwards a valid GET to the session DO and returns its SSE stream", async () => {
    const sseBody = 'event: thread-event\ndata: {"cursor":{"offset":0}}\n\n';
    const sse = createSseAgentDo(sseBody);
    const { env } = createEnv({ AGENT_DO: sse.namespace });

    const response = await probe(env, `/session/events?${SSE_CHANNEL_QUERY}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(
      SSE_CONTENT_TYPE_PATTERN
    );
    expect(await response.text()).toBe(sseBody);
    expect(sse.forwarded).toHaveLength(1);
    const [forwardedRequest] = sse.forwarded;
    expect(forwardedRequest?.method).toBe("GET");
    expect(forwardedRequest?.url).toBe(
      `https://agent.internal/session/events?${SSE_CHANNEL_QUERY}`
    );
  });
});

describe("/trpc dispatch (tRPC fetch adapter)", () => {
  it("answers an unknown procedure with the tRPC 404 NOT_FOUND envelope", async () => {
    const { agentDo, env } = createEnv();
    const response = await probe(env, "/trpc/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.text();
    expect(body).toMatch(TRPC_NOT_FOUND_PATTERN);
    expect(body).not.toMatch(HEALTH_BODY_PATTERN);
    expect(agentDo.getCalls).toBe(0);
  });

  it("answers bare /trpc with the tRPC 404 NOT_FOUND envelope", async () => {
    const { agentDo, env } = createEnv();
    const response = await probe(env, "/trpc");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toMatch(TRPC_NOT_FOUND_PATTERN);
    expect(agentDo.getCalls).toBe(0);
  });

  it("answers an unknown mutation procedure with the same 404 envelope", async () => {
    const { agentDo, env } = createEnv();
    const response = await worker.fetch(
      new Request(`${WORKER_ORIGIN}/trpc/does-not-exist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      env,
      ctx as unknown as ExecutionContext
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toMatch(TRPC_NOT_FOUND_PATTERN);
    expect(agentDo.getCalls).toBe(0);
  });

  it("rejects a content-type-less POST before procedure resolution (415, still tRPC)", async () => {
    const { agentDo, env } = createEnv();
    const response = await probe(env, "/trpc/does-not-exist", "POST");

    expect(response.status).toBe(415);
    expect(await response.text()).not.toMatch(HEALTH_BODY_PATTERN);
    expect(agentDo.getCalls).toBe(0);
  });
});

describe("Telegram webhook catch-all", () => {
  const CATCH_ALL_PATHS = [
    "/",
    "/healthcheck",
    "/healthz/foo",
    "/session/events/replay",
    "/telegram",
  ];

  it.each(CATCH_ALL_PATHS)(
    "dispatches %s to the Telegram handler, never health/tRPC/SSE shapes",
    async (path) => {
      // Block all egress so the Telegram adapter init stays offline-deterministic.
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new Error("NetworkError: egress blocked")))
      );
      const { agentDo, env } = createEnv();

      const response = await probe(env, path);

      expect(response.status).not.toBe(200);
      expect(response.headers.get("content-type")).not.toMatch(
        SSE_CONTENT_TYPE_PATTERN
      );
      const body = await response.text();
      expect(body).not.toMatch(HEALTH_BODY_PATTERN);
      expect(body).not.toMatch(TRPC_NOT_FOUND_PATTERN);
      expect(agentDo.getCalls).toBe(0);
    }
  );

  it("rejects webhook requests without the secret token with a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("NetworkError: egress blocked")))
    );
    const { agentDo, env } = createEnv();

    const response = await probe(env, "/", "POST");

    expect(response.status).toBe(401);
    expect(agentDo.getCalls).toBe(0);
  });
});
