import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import worker from "../index";
import { handleHealthRequest, isHealthPathname } from "./health";

const VERSION_ID = "11111111-2222-3333-4444-555555555555";
const HEALTH_URL = "http://worker.local/healthz";
const STACK_OR_SECRET_LEAK_PATTERN = /stack|Error|\.ts:\d/u;

const ctx = {
  waitUntil() {
    // no-op: health probes schedule no background work
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
      throw new Error("AGENT_DO get() must not run during a health probe");
    },
  } as unknown as DurableObjectNamespace;
  return probe;
}

function createEnv(overrides: Record<string, unknown> = {}): {
  env: Env;
  agentDo: AgentDoProbe;
} {
  const agentDo = createAgentDoProbe();
  const env = {
    AGENT_DO: agentDo.namespace,
    AI_API_KEY: "placeholder-ai-key",
    AI_BASE_URL: "http://127.0.0.1:9/unreachable",
    AI_MODEL: "placeholder-model",
    CF_VERSION_METADATA: { id: VERSION_ID, tag: "placeholder-tag" },
    ENVIRONMENT: "development",
    TELEGRAM_BOT_TOKEN: "placeholder-bot-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "placeholder_webhook_secret",
    ...overrides,
  } as unknown as Env;
  return { agentDo, env };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isHealthPathname", () => {
  it("matches only the exact health path and its trailing-slash variant", () => {
    expect(isHealthPathname("/healthz")).toBe(true);
    expect(isHealthPathname("/healthz/")).toBe(true);
    expect(isHealthPathname("/healthz/foo")).toBe(false);
    expect(isHealthPathname("/healthzZ")).toBe(false);
    expect(isHealthPathname("/health")).toBe(false);
    expect(isHealthPathname("/")).toBe(false);
  });
});

describe("GET /healthz", () => {
  it("returns bounded deterministic JSON reflecting the bindings (development)", async () => {
    const { agentDo, env } = createEnv();
    const bodies: string[] = [];

    for (let i = 0; i < 3; i += 1) {
      const response = await worker.fetch(
        new Request(HEALTH_URL),
        env,
        ctx as unknown as ExecutionContext
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      bodies.push(await response.text());
    }

    expect(new Set(bodies).size).toBe(1);
    const body = bodies[0] ?? "";
    expect(byteLength(body)).toBeLessThan(1024);
    expect(JSON.parse(body)).toEqual({
      agentDo: true,
      environment: "development",
      version: VERSION_ID,
    });
    expect(agentDo.getCalls).toBe(0);
  });

  it("handles the trailing-slash variant identically", async () => {
    const { agentDo, env } = createEnv();
    const plain = await worker.fetch(
      new Request(HEALTH_URL),
      env,
      ctx as unknown as ExecutionContext
    );
    const slashed = await worker.fetch(
      new Request(`${HEALTH_URL}/`),
      env,
      ctx as unknown as ExecutionContext
    );

    expect(slashed.status).toBe(200);
    expect(await slashed.text()).toBe(await plain.text());
    expect(agentDo.getCalls).toBe(0);
  });

  it("shapes the production environment without a version metadata binding", async () => {
    const { agentDo, env } = createEnv({
      CF_VERSION_METADATA: undefined,
      ENVIRONMENT: "production",
    });

    const response = await worker.fetch(
      new Request(HEALTH_URL),
      env,
      ctx as unknown as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(byteLength(body)).toBeLessThan(1024);
    expect(JSON.parse(body)).toEqual({
      agentDo: true,
      environment: "production",
      version: null,
    });
    expect(agentDo.getCalls).toBe(0);
  });

  it("keeps the body byte-identical when secret values change or model env is absent", async () => {
    const first = createEnv();
    const second = createEnv({
      AI_API_KEY: "placeholder-ai-key-swapped",
      AI_BASE_URL: "http://127.0.0.1:9/swapped",
      AI_MODEL: "placeholder-model-swapped",
      TELEGRAM_BOT_TOKEN: "placeholder-bot-token-swapped",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "placeholder_webhook_swapped",
    });
    const bare = createEnv({
      AI_API_KEY: undefined,
      AI_BASE_URL: undefined,
      AI_MODEL: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_WEBHOOK_SECRET_TOKEN: undefined,
    });

    const bodies = await Promise.all(
      [first.env, second.env, bare.env].map(async (env) => {
        const response = await worker.fetch(
          new Request(HEALTH_URL),
          env,
          ctx as unknown as ExecutionContext
        );
        return response.text();
      })
    );

    expect(new Set(bodies).size).toBe(1);
    const body = bodies[0] ?? "";
    expect(body).not.toContain("placeholder-ai-key");
    expect(body).not.toContain("placeholder-bot-token");
    expect(body).not.toContain("placeholder_webhook");
    expect(body).not.toContain("127.0.0.1:9");
    expect(body).not.toContain("placeholder-model");
    expect(second.agentDo.getCalls).toBe(0);
    expect(bare.agentDo.getCalls).toBe(0);
  });

  it("performs zero outbound fetches during probes", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { agentDo, env } = createEnv();

    for (let i = 0; i < 3; i += 1) {
      const response = await worker.fetch(
        new Request(HEALTH_URL),
        env,
        ctx as unknown as ExecutionContext
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(agentDo.getCalls).toBe(0);
  });
});

describe("non-GET /healthz", () => {
  it.each(["POST", "PUT", "DELETE", "PATCH"])(
    "rejects %s with a bounded 405 body before other dispatch",
    async (method) => {
      const { agentDo, env } = createEnv();
      for (const path of ["/healthz", "/healthz/"]) {
        const response = await worker.fetch(
          new Request(`http://worker.local${path}`, { method }),
          env,
          ctx as unknown as ExecutionContext
        );
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("GET");
        const body = await response.text();
        expect(byteLength(body)).toBeLessThan(1024);
        expect(body).toContain("method not allowed");
      }
      expect(agentDo.getCalls).toBe(0);
    }
  );
});

describe("/healthz failure shape", () => {
  it("returns a bounded opaque 503 when AGENT_DO is unbound", async () => {
    const { env } = createEnv({ AGENT_DO: undefined });
    const response = handleHealthRequest(new Request(HEALTH_URL), env);

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.text();
    expect(byteLength(body)).toBeLessThan(1024);
    expect(JSON.parse(body)).toEqual({ error: "unavailable" });
  });

  it("rejects an AGENT_DO binding that exposes no get()", () => {
    const { env } = createEnv({ AGENT_DO: {} });
    const response = handleHealthRequest(new Request(HEALTH_URL), env);
    expect(response.status).toBe(503);
  });

  it("returns 503 when ENVIRONMENT is outside development|production", async () => {
    const { env } = createEnv({ ENVIRONMENT: "staging" });
    const response = handleHealthRequest(new Request(HEALTH_URL), env);

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "unavailable" });
    expect(body).not.toContain("staging");
  });

  it("returns 503 when a bound CF_VERSION_METADATA has no string id", async () => {
    const { env } = createEnv({ CF_VERSION_METADATA: { tag: "no-id" } });
    const response = handleHealthRequest(new Request(HEALTH_URL), env);
    expect(response.status).toBe(503);
    expect(JSON.parse(await response.text())).toEqual({
      error: "unavailable",
    });
  });

  it("leaks no stack, env, or secret material on the failure path", async () => {
    const { env } = createEnv({ AGENT_DO: undefined });
    const response = handleHealthRequest(new Request(HEALTH_URL), env);
    const body = await response.text();

    expect(body).not.toContain("placeholder-ai-key");
    expect(body).not.toContain("placeholder-bot-token");
    expect(body).not.toContain("127.0.0.1:9");
    expect(body).not.toMatch(STACK_OR_SECRET_LEAK_PATTERN);
  });

  it("keeps the failure body byte-identical when secret values change", async () => {
    const first = createEnv({ AGENT_DO: undefined });
    const second = createEnv({
      AGENT_DO: undefined,
      AI_API_KEY: "placeholder-ai-key-swapped",
      TELEGRAM_BOT_TOKEN: "placeholder-bot-token-swapped",
    });

    const firstBody = await handleHealthRequest(
      new Request(HEALTH_URL),
      first.env
    ).text();
    const secondBody = await handleHealthRequest(
      new Request(HEALTH_URL),
      second.env
    ).text();

    expect(firstBody).toBe(secondBody);
  });
});

describe("health sub-paths", () => {
  it("routes /healthz/foo to the catch-all dispatch, not the health route", async () => {
    // Block all egress so the Telegram adapter init stays offline-deterministic.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("NetworkError: egress blocked")))
    );
    const { agentDo, env } = createEnv();
    const response = await worker.fetch(
      new Request("http://worker.local/healthz/foo"),
      env,
      ctx as unknown as ExecutionContext
    );

    expect(response.status).not.toBe(200);
    const body = await response.text();
    expect(body).not.toContain('"environment"');
    expect(agentDo.getCalls).toBe(0);
  });
});
