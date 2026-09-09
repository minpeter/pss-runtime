import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { handleWorkerRpcRequest, workerAgentRouter } from "./worker-rpc";

const WORKER_URL = "https://worker.example.com";
const AUTH_TOKEN = "probe-auth-token";

const durableObjectMock = vi.hoisted(
  (): {
    readonly requests: {
      readonly objectName: string;
      readonly request: Request;
    }[];
  } => ({ requests: [] })
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
    const pathname = new URL(options.request.url).pathname;
    if (pathname === "/session/events/replay") {
      return Promise.resolve(Response.json({ events: [] }));
    }
    if (pathname === "/session/turn") {
      return Promise.resolve(
        Response.json({
          accepted: true,
          runId: "run-1",
          threadKey: "default",
        })
      );
    }
    return Promise.resolve(
      Response.json({
        delivered: true,
        messages: [],
      })
    );
  },
}));

type ProcedureProbe = (
  headers: HeadersInit,
  input?: unknown
) => Promise<Response>;

const VALID_INPUTS = {
  replayEvents: { channel: { id: "local", kind: "tui" } },
  submitTurn: { channel: { id: "local", kind: "tui" }, text: "hello" },
  tuiTurn: { channel: { id: "local", kind: "tui" }, text: "hello" },
} as const;

const PROCEDURES: {
  readonly name: string;
  readonly probe: ProcedureProbe;
  readonly validInput: unknown;
}[] = [
  {
    name: "session.replayEvents",
    probe: (headers, input) => {
      const url = new URL(`${WORKER_URL}/trpc/session.replayEvents`);
      url.searchParams.set(
        "input",
        JSON.stringify(input ?? VALID_INPUTS.replayEvents)
      );
      return handleWorkerRpcRequest(new Request(url, { headers }), createEnv());
    },
    validInput: VALID_INPUTS.replayEvents,
  },
  {
    name: "session.submitTurn",
    probe: (headers, input) =>
      handleWorkerRpcRequest(
        new Request(`${WORKER_URL}/trpc/session.submitTurn`, {
          body: JSON.stringify(input ?? VALID_INPUTS.submitTurn),
          headers: { "content-type": "application/json", ...headers },
          method: "POST",
        }),
        createEnv()
      ),
    validInput: VALID_INPUTS.submitTurn,
  },
  {
    name: "tui.turn",
    probe: (headers, input) =>
      handleWorkerRpcRequest(
        new Request(`${WORKER_URL}/trpc/tui.turn`, {
          body: JSON.stringify(input ?? VALID_INPUTS.tuiTurn),
          headers: { "content-type": "application/json", ...headers },
          method: "POST",
        }),
        createEnv()
      ),
    validInput: VALID_INPUTS.tuiTurn,
  },
];

let envOverrides: Partial<Env> = {};

describe("worker tRPC auth contract", () => {
  beforeEach(() => {
    durableObjectMock.requests.length = 0;
    envOverrides = {};
  });

  it("exposes exactly the three documented procedures", () => {
    const procedures = Object.fromEntries(
      Object.entries(workerAgentRouter._def.procedures).map(
        ([path, procedure]) => [path, readProcedureType(procedure)]
      )
    );

    expect(procedures).toEqual({
      "session.replayEvents": "query",
      "session.submitTurn": "mutation",
      "tui.turn": "mutation",
    });
  });

  describe("batching", () => {
    it.each([1, 8, 256])(
      "bounds unauthenticated unknown-procedure batch responses at %d calls",
      async (count) => {
        const paths = Array.from(
          { length: count },
          (_, index) => `unknown-${index}`
        );
        const input = Object.fromEntries(
          paths.map((_, index) => [index, { json: {} }])
        );
        const response = await handleWorkerRpcRequest(
          new Request(
            `${WORKER_URL}/trpc/${paths.join(",")}?batch=1&input=${encodeURIComponent(
              JSON.stringify(input)
            )}`
          ),
          createEnv()
        );

        expect(response.status).toBe(400);
        expect(Buffer.byteLength(await response.text())).toBeLessThanOrEqual(
          512
        );
      }
    );

    it("still accepts a valid single request", async () => {
      const response = await handleWorkerRpcRequest(
        new Request(`${WORKER_URL}/trpc/tui.turn`, {
          body: JSON.stringify(VALID_INPUTS.tuiTurn),
          headers: {
            authorization: `Bearer ${AUTH_TOKEN}`,
            "content-type": "application/json",
          },
          method: "POST",
        }),
        {
          ...createEnv(),
          ENVIRONMENT: "production",
          WORKER_AGENT_TUI_TOKEN: AUTH_TOKEN,
        }
      );

      expect(response.status).toBe(200);
    });
  });

  describe("production with a configured token", () => {
    beforeEach(() => {
      envOverrides = {
        ENVIRONMENT: "production",
        WORKER_AGENT_TUI_TOKEN: AUTH_TOKEN,
      };
    });

    it.each(
      PROCEDURES.map((procedure) => [procedure.name, procedure] as const)
    )(
      "rejects %s without an exact bearer match and never reaches the Durable Object",
      async (_name, procedure) => {
        const variants: (HeadersInit | undefined)[] = [
          undefined,
          { authorization: `Bearer wrong-${AUTH_TOKEN}` },
          { authorization: `Token ${AUTH_TOKEN}` },
          { authorization: `bearer ${AUTH_TOKEN}` },
          { authorization: `Bearer  ${AUTH_TOKEN}` },
          { authorization: `Bearer ${AUTH_TOKEN}-suffix` },
          { authorization: "Bearer" },
        ];

        for (const headers of variants) {
          durableObjectMock.requests.length = 0;
          const response = await procedure.probe(headers ?? {});
          await expectUnauthorized(response);
        }
      }
    );

    it.each(
      PROCEDURES.map((procedure) => [procedure.name, procedure] as const)
    )("accepts %s with the exact bearer token", async (_name, procedure) => {
      const response = await procedure.probe({
        authorization: `Bearer ${AUTH_TOKEN}`,
      });

      expect(response.status).toBe(200);
      expect(durableObjectMock.requests).toHaveLength(1);
    });

    it("raises UNAUTHORIZED before input validation or dispatch", async () => {
      // Malformed input plus missing auth must surface 401, never 400.
      const malformed = { limit: 0 };
      const url = new URL(`${WORKER_URL}/trpc/session.replayEvents`);
      url.searchParams.set("input", JSON.stringify(malformed));

      const rejected = await handleWorkerRpcRequest(
        new Request(url),
        createEnv()
      );
      await expectUnauthorized(rejected);

      const authorized = await handleWorkerRpcRequest(
        new Request(url, {
          headers: { authorization: `Bearer ${AUTH_TOKEN}` },
        }),
        createEnv()
      );
      expect(authorized.status).toBe(400);
      const envelope = (await authorized.json()) as {
        readonly error?: { readonly data?: { readonly code?: string } };
      };
      expect(envelope.error?.data?.code).toBe("BAD_REQUEST");
      expect(durableObjectMock.requests).toEqual([]);
    });

    it("answers unknown procedures with NOT_FOUND even when authorized", async () => {
      for (const path of ["tui.inspect", "session.inspect", "session.list"]) {
        durableObjectMock.requests.length = 0;
        const url = new URL(`${WORKER_URL}/trpc/${path}`);
        url.searchParams.set(
          "input",
          JSON.stringify({ conversationKey: "telegram:123" })
        );
        const response = await handleWorkerRpcRequest(
          new Request(url, {
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
          }),
          createEnv()
        );
        await expectNotFound(response);
      }
    });
  });

  describe("production without a configured token fails closed", () => {
    beforeEach(() => {
      envOverrides = { ENVIRONMENT: "production" };
    });

    it.each(
      PROCEDURES.map((procedure) => [procedure.name, procedure] as const)
    )("rejects %s with and without any header", async (_name, procedure) => {
      const variants: HeadersInit[] = [
        {},
        { authorization: `Bearer ${AUTH_TOKEN}` },
      ];
      for (const headers of variants) {
        durableObjectMock.requests.length = 0;
        const response = await procedure.probe(headers);
        await expectUnauthorized(response);
      }
    });
  });

  describe("development without a configured token is open", () => {
    beforeEach(() => {
      envOverrides = { ENVIRONMENT: "development" };
    });

    it.each(
      PROCEDURES.map((procedure) => [procedure.name, procedure] as const)
    )(
      "accepts %s without any authorization header",
      async (_name, procedure) => {
        const response = await procedure.probe({});

        expect(response.status).toBe(200);
        expect(durableObjectMock.requests).toHaveLength(1);
      }
    );

    it("still validates input after the open auth gate", async () => {
      const url = new URL(`${WORKER_URL}/trpc/session.replayEvents`);
      url.searchParams.set("input", JSON.stringify({ limit: 0 }));

      const response = await handleWorkerRpcRequest(
        new Request(url),
        createEnv()
      );

      expect(response.status).toBe(400);
      expect(durableObjectMock.requests).toEqual([]);
    });

    it("answers internal known-key probes with NOT_FOUND and no Durable Object hop", async () => {
      const url = new URL(`${WORKER_URL}/trpc/tui.inspect`);
      url.searchParams.set(
        "input",
        JSON.stringify({ conversationKey: "telegram:123" })
      );

      const response = await handleWorkerRpcRequest(
        new Request(url),
        createEnv()
      );

      await expectNotFound(response);
    });
  });

  describe("development with a configured token enforces auth exactly like production", () => {
    beforeEach(() => {
      envOverrides = {
        ENVIRONMENT: "development",
        WORKER_AGENT_TUI_TOKEN: AUTH_TOKEN,
      };
    });

    it.each(
      PROCEDURES.map((procedure) => [procedure.name, procedure] as const)
    )(
      "rejects %s without the exact bearer token and accepts it with one",
      async (_name, procedure) => {
        const rejected = await procedure.probe({});
        await expectUnauthorized(rejected);

        const wrongScheme = await procedure.probe({
          authorization: `Token ${AUTH_TOKEN}`,
        });
        await expectUnauthorized(wrongScheme);

        const accepted = await procedure.probe({
          authorization: `Bearer ${AUTH_TOKEN}`,
        });
        expect(accepted.status).toBe(200);
        expect(durableObjectMock.requests).toHaveLength(1);
      }
    );
  });
});

function readProcedureType(procedure: unknown): string {
  const definition = (
    procedure as { readonly _def?: { readonly type?: unknown } }
  )._def;
  if (typeof definition?.type !== "string") {
    throw new Error("expected a tRPC procedure with a string type");
  }
  return definition.type;
}

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  const envelope = (await response.json()) as {
    readonly error?: {
      readonly data?: { readonly code?: string; readonly httpStatus?: number };
    };
  };
  expect(envelope.error?.data?.code).toBe("UNAUTHORIZED");
  expect(envelope.error?.data?.httpStatus).toBe(401);
  expect(durableObjectMock.requests).toEqual([]);
}

async function expectNotFound(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  const envelope = (await response.json()) as {
    readonly error?: {
      readonly data?: { readonly code?: string; readonly httpStatus?: number };
    };
  };
  expect(envelope.error?.data?.code).toBe("NOT_FOUND");
  expect(envelope.error?.data?.httpStatus).toBe(404);
  expect(durableObjectMock.requests).toEqual([]);
}

function createEnv(): Env {
  return {
    AGENT_DO: createDurableObjectNamespace(),
    AI_API_KEY: "test-key",
    ENVIRONMENT: "development",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
    ...envOverrides,
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
