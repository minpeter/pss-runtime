import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { SubmitTurnResponseSchema } from "../session/session-contract";
import { handleWorkerRpcRequest } from "./worker-rpc";

const WORKER_URL = "https://worker.example.com";
const PROBE_TOKEN = "probe-token";
const ECHO_CANARY = "do-not-echo-this-turn-text";

type DurableObjectOutcome =
  | { readonly kind: "reject"; readonly error: Error }
  | { readonly kind: "respond"; readonly response: Response }
  | { readonly kind: "unreachable" };

const durableObjectMock = vi.hoisted(
  (): {
    readonly requests: {
      readonly objectName: string;
      readonly request: Request;
    }[];
    readonly outcomes: DurableObjectOutcome[];
  } => ({
    requests: [],
    outcomes: [],
  })
);

vi.mock("@minpeter/pss-runtime/platform/durable-object/cloudflare", () => ({
  fetchCloudflareDurableObject: (options: unknown) => {
    if (
      !(
        typeof options === "object" &&
        options !== null &&
        "objectName" in options &&
        typeof options.objectName === "string" &&
        "request" in options &&
        options.request instanceof Request
      )
    ) {
      throw new Error("Expected Durable Object fetch options.");
    }
    durableObjectMock.requests.push({
      objectName: options.objectName,
      request: options.request,
    });
    const outcome = durableObjectMock.outcomes.shift();
    if (outcome?.kind === "reject") {
      return Promise.reject(outcome.error);
    }
    if (outcome?.kind === "unreachable") {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(
      outcome?.response ??
        Response.json({
          accepted: true,
          runId: "run-1",
          threadKey: "default",
        })
    );
  },
}));

const VALID_INPUT = {
  channel: { id: "local", kind: "tui" },
  text: "hello",
} as const;

describe("session.submitTurn tRPC contract", () => {
  beforeEach(() => {
    durableObjectMock.requests.length = 0;
    durableObjectMock.outcomes.length = 0;
  });

  it("returns the tRPC success envelope with a schema-valid admission", async () => {
    durableObjectMock.outcomes.push({
      kind: "respond",
      response: Response.json({
        accepted: true,
        runId: "run-42",
        threadKey: "default",
      }),
    });

    const response = await submitTurn(VALID_INPUT);

    expect(response.status).toBe(200);
    const envelope = (await response.json()) as {
      readonly result?: { readonly data?: Record<string, unknown> };
    };
    const parsed = SubmitTurnResponseSchema.safeParse(envelope.result?.data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("expected a schema-valid admission envelope");
    }
    expect(parsed.data.accepted).toBe(true);
    expect(parsed.data.runId).toBe("run-42");
    expect(parsed.data.threadKey).toBe("default");
    expect(parsed.data.runId.length).toBeGreaterThan(0);
    expect(parsed.data.threadKey.length).toBeGreaterThan(0);
    expect("eventCursor" in parsed.data).toBe(false);
  });

  it("passes eventCursor through only when the durable admission returns one", async () => {
    durableObjectMock.outcomes.push({
      kind: "respond",
      response: Response.json({
        accepted: true,
        eventCursor: { offset: 7 },
        runId: "run-43",
        threadKey: "default",
      }),
    });

    const response = await submitTurn(VALID_INPUT);

    expect(response.status).toBe(200);
    const envelope = (await response.json()) as {
      readonly result?: { readonly data?: Record<string, unknown> };
    };
    const parsed = SubmitTurnResponseSchema.safeParse(envelope.result?.data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("expected a schema-valid admission envelope");
    }
    expect(parsed.data.eventCursor).toEqual({ offset: 7 });
  });

  it("trims admission fields and omits absent optional keys before the hop", async () => {
    const response = await submitTurn({
      channel: { id: " local ", kind: "tui" },
      text: " hello ",
    });

    expect(response.status).toBe(200);
    const [request] = durableObjectMock.requests;
    if (!request) {
      throw new Error("expected a Durable Object request");
    }
    expect(new URL(request.request.url).pathname).toBe("/session/turn");
    await expect(request.request.json()).resolves.toEqual({
      channel: { id: "local", kind: "tui" },
      text: "hello",
    });
  });

  it("forwards a trimmed idempotencyKey and sessionScopeKey", async () => {
    const response = await submitTurn({
      channel: { id: "local", kind: "tui" },
      idempotencyKey: " turn-9 ",
      sessionScopeKey: " tui:user ",
      text: "hello",
    });

    expect(response.status).toBe(200);
    const [request] = durableObjectMock.requests;
    if (!request) {
      throw new Error("expected a Durable Object request");
    }
    await expect(request.request.json()).resolves.toEqual({
      channel: { id: "local", kind: "tui" },
      idempotencyKey: "turn-9",
      sessionScopeKey: "tui:user",
      text: "hello",
    });
  });

  it.each([
    [
      "whitespace-only text",
      { channel: { id: "local", kind: "tui" }, text: "   " },
    ],
    ["non-string text", { channel: { id: "local", kind: "tui" }, text: 42 }],
    ["missing text", { channel: { id: "local", kind: "tui" } }],
    ["a blank channel id", { channel: { id: "", kind: "tui" }, text: "hello" }],
    [
      "a whitespace channel id",
      { channel: { id: "   ", kind: "tui" }, text: "hello" },
    ],
    ["a missing channel", { text: "hello" }],
    [
      "an unknown channel kind",
      { channel: { id: "local", kind: "sms" }, text: "hello" },
    ],
    [
      "an extra top-level key",
      { channel: { id: "local", kind: "tui" }, text: "hello", extra: true },
    ],
    [
      "an extra channel key",
      {
        channel: { id: "local", kind: "tui", room: "x" },
        text: "hello",
      },
    ],
    [
      "a non-string idempotencyKey",
      {
        channel: { id: "local", kind: "tui" },
        idempotencyKey: 7,
        text: "hello",
      },
    ],
    ["a string body", '"hello"'],
    ["an array body", "[1,2,3]"],
    ["a number body", "42"],
    ["a null body", "null"],
  ])(
    "rejects %s with a BAD_REQUEST envelope and no Durable Object hop",
    async (_label, input) => {
      const response = await submitTurn(input);

      const body = await expectErrorEnvelope(response, 400, "BAD_REQUEST");
      expectBoundedErrorBody(body);
      expect(durableObjectMock.requests).toEqual([]);
    }
  );

  it.each([
    ["GET", "/trpc/session.submitTurn"],
    ["GET", "/trpc/tui.turn"],
    ["POST", "/trpc/session.replayEvents"],
  ])(
    "rejects a %s on %s at the adapter before handler logic",
    async (method, path) => {
      const response = await probeMethod(path, method);

      const body = await expectErrorEnvelope(
        response,
        405,
        "METHOD_NOT_SUPPORTED"
      );
      expectBoundedErrorBody(body);
      expect(durableObjectMock.requests).toEqual([]);
    }
  );
});

describe("session procedure upstream failure mapping", () => {
  beforeEach(() => {
    durableObjectMock.requests.length = 0;
    durableObjectMock.outcomes.length = 0;
  });

  it("maps an unreachable Durable Object to a bounded BAD_GATEWAY", async () => {
    durableObjectMock.outcomes.push({ kind: "unreachable" });

    const response = await submitTurn({
      channel: { id: "local", kind: "tui" },
      text: ECHO_CANARY,
    });

    const body = await expectErrorEnvelope(response, 502, "BAD_GATEWAY");
    expect(body).toContain("agent durable object unavailable");
    expectBoundedErrorBody(body);
  });

  it("maps a non-OK Durable Object response to a bounded BAD_GATEWAY", async () => {
    durableObjectMock.outcomes.push({
      kind: "respond",
      response: new Response("upstream exploded", { status: 503 }),
    });

    const response = await submitTurn({
      channel: { id: "local", kind: "tui" },
      text: ECHO_CANARY,
    });

    const body = await expectErrorEnvelope(response, 502, "BAD_GATEWAY");
    expect(body).toContain("503");
    expectBoundedErrorBody(body);
    expect(body).not.toContain("upstream exploded");
  });

  it("maps a rejected Durable Object fetch to a bounded BAD_GATEWAY", async () => {
    durableObjectMock.outcomes.push({
      kind: "reject",
      error: new Error("durable object stub internal detail: DO-12345"),
    });

    const response = await submitTurn({
      channel: { id: "local", kind: "tui" },
      text: ECHO_CANARY,
    });

    const body = await expectErrorEnvelope(response, 502, "BAD_GATEWAY");
    expectBoundedErrorBody(body);
    expect(body).not.toContain("DO-12345");
  });

  it("maps a schema-invalid Durable Object payload to a generic 500", async () => {
    durableObjectMock.outcomes.push({
      kind: "respond",
      response: Response.json({ accepted: false, reason: "refused" }),
    });

    const response = await submitTurn({
      channel: { id: "local", kind: "tui" },
      text: ECHO_CANARY,
    });

    const body = await expectErrorEnvelope(
      response,
      500,
      "INTERNAL_SERVER_ERROR"
    );
    expectGenericInternalErrorBody(body);
    expect(body).not.toContain("refused");
  });

  it("maps an unparsable Durable Object body to a generic 500", async () => {
    durableObjectMock.outcomes.push({
      kind: "respond",
      response: new Response("not json at all", {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    });

    const response = await submitTurn({
      channel: { id: "local", kind: "tui" },
      text: ECHO_CANARY,
    });

    const body = await expectErrorEnvelope(
      response,
      500,
      "INTERNAL_SERVER_ERROR"
    );
    expectGenericInternalErrorBody(body);
  });

  it("maps session.replayEvents upstream failures the same way", async () => {
    durableObjectMock.outcomes.push({ kind: "unreachable" });

    const url = new URL(`${WORKER_URL}/trpc/session.replayEvents`);
    url.searchParams.set(
      "input",
      JSON.stringify({ channel: { id: "local", kind: "tui" } })
    );
    const response = await handleWorkerRpcRequest(
      new Request(url, {
        headers: { authorization: `Bearer ${PROBE_TOKEN}` },
      }),
      createEnv()
    );

    const body = await expectErrorEnvelope(response, 502, "BAD_GATEWAY");
    expectBoundedErrorBody(body);
  });
});

function submitTurn(input: unknown): Promise<Response> {
  return probeMethod("/trpc/session.submitTurn", "POST", input);
}

function probeMethod(
  path: string,
  method: string,
  input: unknown = VALID_INPUT
): Promise<Response> {
  const url = new URL(`${WORKER_URL}${path}`);
  const headers: Record<string, string> = {
    authorization: `Bearer ${PROBE_TOKEN}`,
  };
  let body: string | undefined;
  if (method === "POST") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(input ?? null);
  } else {
    url.searchParams.set("input", JSON.stringify(input ?? null));
  }
  return handleWorkerRpcRequest(
    new Request(url, { body, headers, method }),
    createEnv()
  );
}

/** Asserts the status/code and returns the raw body for negative greps. */
async function expectErrorEnvelope(
  response: Response,
  httpStatus: number,
  code: string
): Promise<string> {
  expect(response.status).toBe(httpStatus);
  const body = await response.text();
  const envelope = JSON.parse(body) as {
    readonly error?: {
      readonly data?: { readonly code?: string; readonly httpStatus?: number };
    };
  };
  expect(envelope.error?.data?.code).toBe(code);
  expect(envelope.error?.data?.httpStatus).toBe(httpStatus);
  return body;
}

function expectBoundedErrorBody(body: string): void {
  expect(body).not.toContain(ECHO_CANARY);
  expect(body.toLowerCase()).not.toContain("stack");
  expect(body).not.toContain("SyntaxError");
  expect(body).not.toContain("ZodError");
  expect(body).not.toContain("\n");
  expect(body.length).toBeLessThan(1024);
}

/** A 500 envelope must carry only the fixed generic message, no internals. */
function expectGenericInternalErrorBody(body: string): void {
  expectBoundedErrorBody(body);
  const envelope = JSON.parse(body) as {
    readonly error?: { readonly message?: string };
  };
  expect(envelope.error?.message).toBe("internal error");
}

function createEnv(): Env {
  return {
    AGENT_DO: createDurableObjectNamespace(),
    AI_API_KEY: "test-key",
    ENVIRONMENT: "production",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
    WORKER_AGENT_TUI_TOKEN: PROBE_TOKEN,
  };
}

function createDurableObjectNamespace(): DurableObjectNamespace {
  const namespace: DurableObjectNamespace = {
    get(_id: DurableObjectId) {
      throw new Error("namespace should not be fetched");
    },
    getByName(_name: string) {
      throw new Error("namespace should not be fetched");
    },
    idFromString(id: string) {
      return createDurableObjectId(id);
    },
    idFromName(name: string) {
      return createDurableObjectId(name);
    },
    jurisdiction() {
      return namespace;
    },
    newUniqueId() {
      return createDurableObjectId("unique");
    },
  };
  return namespace;
}

function createDurableObjectId(name: string): DurableObjectId {
  return {
    equals(other: DurableObjectId) {
      return other.toString() === name;
    },
    name,
    toString() {
      return name;
    },
  };
}
