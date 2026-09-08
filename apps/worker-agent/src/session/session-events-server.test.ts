import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { handleSessionEventsRequest } from "./session-events-server";

const durableObjectMock = vi.hoisted(
  (): {
    readonly requests: Request[];
    respond: (request: Request) => Promise<Response | undefined>;
  } => ({
    requests: [],
    respond: () =>
      Promise.resolve(
        new Response("event: ready\ndata: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      ),
  })
);

vi.mock("@minpeter/pss-runtime/platform/durable-object/cloudflare", () => ({
  fetchCloudflareDurableObject: (options: unknown) => {
    if (
      !(
        typeof options === "object" &&
        options !== null &&
        "request" in options &&
        options.request instanceof Request
      )
    ) {
      throw new Error("Expected Durable Object fetch options.");
    }
    durableObjectMock.requests.push(options.request);
    return durableObjectMock.respond(options.request);
  },
}));

describe("session SSE worker route", () => {
  beforeEach(() => {
    durableObjectMock.requests.length = 0;
    durableObjectMock.respond = () =>
      Promise.resolve(
        new Response("event: ready\ndata: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        })
      );
  });

  it("rejects a production stream without bearer auth", async () => {
    const response = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?channel=tui%3Alocal"),
      createEnv()
    );

    expect(response.status).toBe(401);
    expect(durableObjectMock.requests).toEqual([]);
  });

  it("proxies an authorized cursor stream to the channel Durable Object", async () => {
    const response = await handleSessionEventsRequest(
      new Request(
        "https://worker.example/session/events?channel=tui%3Alocal&after=4&sessionScopeKey=tui%3Auser",
        { headers: { authorization: "Bearer secret" } }
      ),
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-transform"
    );
    expect(response.headers.get("connection")).toBe("keep-alive");
    expect(durableObjectMock.requests).toHaveLength(1);
    const internal = durableObjectMock.requests[0];
    if (!internal) {
      throw new Error("expected internal event stream request");
    }
    const url = new URL(internal.url);
    expect(url.pathname).toBe("/session/events");
    expect(url.searchParams.get("channel")).toBe("tui:local");
    expect(url.searchParams.get("after")).toBe("4");
    expect(url.searchParams.get("sessionScopeKey")).toBe("tui:user");
  });

  it("streams without a header when development has no token configured", async () => {
    const response = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?channel=tui%3Alocal"),
      createEnv({
        ENVIRONMENT: "development",
        WORKER_AGENT_TUI_TOKEN: undefined,
      })
    );

    expect(response.status).toBe(200);
    expect(durableObjectMock.requests).toHaveLength(1);
  });

  it("requires the exact bearer token in development when a token is configured", async () => {
    const env = createEnv({ ENVIRONMENT: "development" });

    const missing = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?channel=tui%3Alocal"),
      env
    );
    expect(missing.status).toBe(401);

    const wrongScheme = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?channel=tui%3Alocal", {
        headers: { authorization: "Token secret" },
      }),
      env
    );
    expect(wrongScheme.status).toBe(401);

    const doubleSpace = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?channel=tui%3Alocal", {
        headers: { authorization: "Bearer  secret" },
      }),
      env
    );
    expect(doubleSpace.status).toBe(401);

    const accepted = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?channel=tui%3Alocal", {
        headers: { authorization: "Bearer secret" },
      }),
      env
    );
    expect(accepted.status).toBe(200);

    expect(durableObjectMock.requests).toHaveLength(1);
  });

  it("rejects a non-GET before authorization with 405 and no Durable Object fetch", async () => {
    const response = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?channel=tui%3Alocal", {
        method: "POST",
      }),
      createEnv()
    );

    expect(response.status).toBe(405);
    await expect(response.text()).resolves.toBe("method not allowed");
    expect(durableObjectMock.requests).toEqual([]);
  });

  it("rejects unauthorized requests before channel parsing with no Durable Object fetch", async () => {
    const response = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events"),
      createEnv()
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("unauthorized");
    expect(durableObjectMock.requests).toEqual([]);
  });

  it("requires the channel parameter after authorization with no Durable Object fetch", async () => {
    const response = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?after=3", {
        headers: { authorization: "Bearer secret" },
      }),
      createEnv()
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("channel required");
    expect(durableObjectMock.requests).toEqual([]);
  });

  it.each([
    ["missing separator", "local"],
    ["blank kind", ":local"],
    ["blank id", "tui:"],
    ["whitespace id", "tui:%20%20"],
    ["unknown kind", "web:local"],
  ])(
    "rejects an unparseable channel (%s) with 400 and no Durable Object fetch",
    async (_label, channel) => {
      const response = await handleSessionEventsRequest(
        new Request(
          `https://worker.example/session/events?channel=${channel}`,
          { headers: { authorization: "Bearer secret" } }
        ),
        createEnv()
      );

      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toBe(
        "invalid session event stream"
      );
      expect(durableObjectMock.requests).toEqual([]);
    }
  );

  it.each([
    ["empty", ""],
    ["negative", "-1"],
    ["zero-padded", "01"],
    ["decimal", "1.5"],
    ["hex", "0x10"],
    ["non-numeric", "not-a-cursor"],
    ["unsafe integer", "9007199254740993"],
  ])(
    "rejects a malformed after cursor (%s) with 400 and no Durable Object fetch",
    async (_label, after) => {
      const response = await handleSessionEventsRequest(
        new Request(
          `https://worker.example/session/events?channel=tui%3Alocal&after=${after}`,
          { headers: { authorization: "Bearer secret" } }
        ),
        createEnv()
      );

      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toBe(
        "invalid session event stream"
      );
      expect(durableObjectMock.requests).toEqual([]);
    }
  );

  it("replays from the beginning when after is absent", async () => {
    const response = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?channel=tui%3Alocal", {
        headers: { authorization: "Bearer secret" },
      }),
      createEnv()
    );

    expect(response.status).toBe(200);
    expect(durableObjectMock.requests).toHaveLength(1);
    const internal = durableObjectMock.requests[0];
    if (!internal) {
      throw new Error("expected internal event stream request");
    }
    const url = new URL(internal.url);
    expect(url.searchParams.has("after")).toBe(false);
    expect(url.searchParams.get("channel")).toBe("tui:local");
  });

  it("forwards a trimmed sessionScopeKey and omits a blank one", async () => {
    const trimmed = await handleSessionEventsRequest(
      new Request(
        "https://worker.example/session/events?channel=tui%3Alocal&sessionScopeKey=%20%20scope%20%20",
        { headers: { authorization: "Bearer secret" } }
      ),
      createEnv()
    );
    expect(trimmed.status).toBe(200);
    const first = durableObjectMock.requests[0];
    if (!first) {
      throw new Error("expected internal event stream request");
    }
    expect(new URL(first.url).searchParams.get("sessionScopeKey")).toBe(
      "scope"
    );

    durableObjectMock.requests.length = 0;
    const blank = await handleSessionEventsRequest(
      new Request(
        "https://worker.example/session/events?channel=tui%3Alocal&sessionScopeKey=%20%20",
        { headers: { authorization: "Bearer secret" } }
      ),
      createEnv()
    );
    expect(blank.status).toBe(200);
    const second = durableObjectMock.requests[0];
    if (!second) {
      throw new Error("expected internal event stream request");
    }
    expect(new URL(second.url).searchParams.has("sessionScopeKey")).toBe(false);
  });

  it("returns a bounded 502 without SSE frames when the Durable Object is unreachable", async () => {
    durableObjectMock.respond = () => Promise.resolve(undefined);

    const response = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?channel=tui%3Alocal", {
        headers: { authorization: "Bearer secret" },
      }),
      createEnv()
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream"
    );
    const body = await response.text();
    expect(body).toBe("agent durable object unavailable");
    expect(body).not.toContain("id:");
    expect(body).not.toContain("event:");
    expect(body).not.toContain("data:");
  });

  it("returns a bounded 502 when the Durable Object fetch rejects", async () => {
    durableObjectMock.respond = () =>
      Promise.reject(new Error("internal stub failure with identifiers"));

    const response = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?channel=tui%3Alocal", {
        headers: { authorization: "Bearer secret" },
      }),
      createEnv()
    );

    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toBe("agent durable object unavailable");
    expect(body).not.toContain("internal stub failure");
  });

  it("returns a bounded 502 when the Durable Object answers non-OK", async () => {
    durableObjectMock.respond = () =>
      Promise.resolve(
        new Response("event: thread-event\ndata: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
          status: 500,
        })
      );

    const response = await handleSessionEventsRequest(
      new Request("https://worker.example/session/events?channel=tui%3Alocal", {
        headers: { authorization: "Bearer secret" },
      }),
      createEnv()
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream"
    );
    const body = await response.text();
    expect(body).toBe("agent durable object unavailable");
    expect(body).not.toContain("event:");
  });
});

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    AGENT_DO: {
      get: () => {
        throw new Error("namespace should be mocked");
      },
      getByName: () => {
        throw new Error("namespace should be mocked");
      },
      idFromName: (name: string) => ({ name, toString: () => name }),
    } as unknown as DurableObjectNamespace,
    AI_API_KEY: "test-key",
    ENVIRONMENT: "production",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
    WORKER_AGENT_TUI_TOKEN: "secret",
    ...overrides,
  };
}
