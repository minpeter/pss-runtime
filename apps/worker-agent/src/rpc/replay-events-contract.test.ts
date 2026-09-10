import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { ReplayEventsResponseSchema } from "../session/session-contract";
import { handleWorkerRpcRequest } from "./worker-rpc";

const WORKER_URL = "https://worker.example.com";
const PROBE_TOKEN = "probe-token";

const durableObjectMock = vi.hoisted(
  (): {
    readonly requests: {
      readonly objectName: string;
      readonly request: Request;
    }[];
    readonly responses: Response[];
  } => ({
    requests: [],
    responses: [],
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
    return Promise.resolve(
      durableObjectMock.responses.shift() ??
        Response.json({
          events: [],
        })
    );
  },
}));

describe("session.replayEvents tRPC contract", () => {
  beforeEach(() => {
    durableObjectMock.requests.length = 0;
    durableObjectMock.responses.length = 0;
  });

  it("returns the tRPC success envelope with a schema-valid event page", async () => {
    durableObjectMock.responses.push(
      Response.json({
        events: [
          {
            cursor: { offset: 1 },
            event: { type: "turn-start" },
            threadKey: "default",
          },
          {
            cursor: { offset: 2 },
            event: { text: "hi", type: "assistant-output" },
            threadKey: "default",
          },
        ],
        nextCursor: { offset: 2 },
      })
    );

    const response = await queryReplayEvents({
      channel: { id: "local", kind: "tui" },
    });

    expect(response.status).toBe(200);
    const envelope = (await response.json()) as {
      readonly result?: { readonly data?: unknown };
    };
    const parsed = ReplayEventsResponseSchema.safeParse(envelope.result?.data);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("expected a schema-valid replay page");
    }
    expect(parsed.data.events).toHaveLength(2);
    for (const event of parsed.data.events) {
      expect(Number.isSafeInteger(event.cursor.offset)).toBe(true);
      expect(event.cursor.offset).toBeGreaterThanOrEqual(0);
      expect(typeof event.event.type).toBe("string");
      expect(typeof event.threadKey).toBe("string");
    }
    expect(parsed.data.nextCursor).toEqual({ offset: 2 });
    expect(parsed.data.nextCursor).toEqual(parsed.data.events.at(-1)?.cursor);
  });

  it("omits nextCursor on an empty page", async () => {
    durableObjectMock.responses.push(Response.json({ events: [] }));

    const response = await queryReplayEvents({
      after: { offset: 7 },
      channel: { id: "local", kind: "tui" },
    });

    expect(response.status).toBe(200);
    const envelope = (await response.json()) as {
      readonly result?: { readonly data?: Record<string, unknown> };
    };
    expect(envelope.result?.data).toEqual({ events: [] });
    expect(envelope.result?.data && "nextCursor" in envelope.result.data).toBe(
      false
    );
  });

  it("starts at the beginning when after is omitted", async () => {
    durableObjectMock.responses.push(Response.json({ events: [] }));

    const response = await queryReplayEvents({
      channel: { id: "local", kind: "tui" },
    });

    expect(response.status).toBe(200);
    const [request] = durableObjectMock.requests;
    if (!request) {
      throw new Error("expected a Durable Object request");
    }
    const payload = (await request.request.json()) as Record<string, unknown>;
    expect("after" in payload).toBe(false);
  });

  it("round-trips nextCursor as the next exclusive after", async () => {
    durableObjectMock.responses.push(
      Response.json({
        events: [
          {
            cursor: { offset: 1 },
            event: { type: "turn-start" },
            threadKey: "default",
          },
          {
            cursor: { offset: 2 },
            event: { text: "one", type: "assistant-output" },
            threadKey: "default",
          },
        ],
        nextCursor: { offset: 2 },
      }),
      Response.json({
        events: [
          {
            cursor: { offset: 3 },
            event: { type: "turn-end" },
            threadKey: "default",
          },
        ],
        nextCursor: { offset: 3 },
      })
    );

    const first = await queryReplayEvents({
      channel: { id: "local", kind: "tui" },
      limit: 2,
    });
    expect(first.status).toBe(200);
    const firstEnvelope = (await first.json()) as {
      readonly result: {
        readonly data: {
          readonly events: readonly {
            readonly cursor: { readonly offset: number };
          }[];
          readonly nextCursor?: { readonly offset: number };
        };
      };
    };
    const nextCursor = firstEnvelope.result.data.nextCursor;
    expect(nextCursor).toEqual({ offset: 2 });

    const second = await queryReplayEvents({
      after: nextCursor,
      channel: { id: "local", kind: "tui" },
      limit: 2,
    });
    expect(second.status).toBe(200);
    const secondEnvelope = (await second.json()) as {
      readonly result: {
        readonly data: {
          readonly events: readonly {
            readonly cursor: { readonly offset: number };
          }[];
        };
      };
    };

    const secondRequest = durableObjectMock.requests[1];
    if (!secondRequest) {
      throw new Error("expected a second Durable Object request");
    }
    const payload = (await secondRequest.request.json()) as Record<
      string,
      unknown
    >;
    expect(payload.after).toEqual({ offset: 2 });

    const firstOffsets = firstEnvelope.result.data.events.map(
      (event) => event.cursor.offset
    );
    const secondOffsets = secondEnvelope.result.data.events.map(
      (event) => event.cursor.offset
    );
    for (const offset of secondOffsets) {
      expect(offset).toBeGreaterThan(2);
      expect(firstOffsets).not.toContain(offset);
    }
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["above the maximum", 101],
    ["fractional", 1.5],
    ["non-number", "ten"],
  ])(
    "rejects a %s limit with a BAD_REQUEST envelope and no Durable Object hop",
    async (_label, limit) => {
      const response = await queryReplayEvents({
        channel: { id: "local", kind: "tui" },
        limit,
      });

      await expectBadRequest(response);
      expect(durableObjectMock.requests).toEqual([]);
    }
  );

  it.each([
    ["one", 1],
    ["the maximum", 100],
  ])(
    "accepts a limit of %s and forwards it within range",
    async (_label, limit) => {
      durableObjectMock.responses.push(Response.json({ events: [] }));

      const response = await queryReplayEvents({
        channel: { id: "local", kind: "tui" },
        limit,
      });

      expect(response.status).toBe(200);
      const [request] = durableObjectMock.requests;
      if (!request) {
        throw new Error("expected a Durable Object request");
      }
      const payload = (await request.request.json()) as Record<string, unknown>;
      expect(payload.limit).toBe(limit);
    }
  );

  it("accepts an absent limit and emits a page within the maximum", async () => {
    const events = Array.from({ length: 100 }, (_, index) => ({
      cursor: { offset: index + 1 },
      event: { type: "assistant-output" },
      threadKey: "default",
    }));
    durableObjectMock.responses.push(
      Response.json({ events, nextCursor: { offset: 100 } })
    );

    const response = await queryReplayEvents({
      channel: { id: "local", kind: "tui" },
    });

    expect(response.status).toBe(200);
    const envelope = (await response.json()) as {
      readonly result: {
        readonly data: { readonly events: readonly unknown[] };
      };
    };
    expect(envelope.result.data.events.length).toBeLessThanOrEqual(100);
  });

  it.each([
    ["a missing channel", { limit: 5 }],
    ["a blank channel id", { channel: { id: "", kind: "tui" } }],
    ["a whitespace channel id", { channel: { id: "   ", kind: "tui" } }],
    ["an unknown channel kind", { channel: { id: "local", kind: "sms" } }],
    [
      "a negative after offset",
      { after: { offset: -1 }, channel: { id: "local", kind: "tui" } },
    ],
    [
      "a fractional after offset",
      { after: { offset: 1.5 }, channel: { id: "local", kind: "tui" } },
    ],
    [
      "an overflowing after offset",
      '{"after":{"offset":1e999},"channel":{"id":"local","kind":"tui"}}',
    ],
    [
      "an after cursor with extra keys",
      {
        after: { extra: true, offset: 0 },
        channel: { id: "local", kind: "tui" },
      },
    ],
    [
      "a non-object after cursor",
      { after: "abc", channel: { id: "local", kind: "tui" } },
    ],
    ["a string body", '"hello"'],
    ["an array body", "[1,2,3]"],
    ["a number body", "42"],
    ["a null body", "null"],
  ])(
    "rejects %s with a BAD_REQUEST envelope and no Durable Object hop",
    async (_label, input) => {
      const response = await queryReplayEvents(input);

      await expectBadRequest(response);
      expect(durableObjectMock.requests).toEqual([]);
    }
  );
});

async function expectBadRequest(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  const envelope = (await response.json()) as {
    readonly error?: {
      readonly data?: { readonly code?: string; readonly httpStatus?: number };
    };
  };
  expect(envelope.error?.data?.code).toBe("BAD_REQUEST");
  expect(envelope.error?.data?.httpStatus).toBe(400);
}

function queryReplayEvents(input: unknown): Promise<Response> {
  const url = new URL(`${WORKER_URL}/trpc/session.replayEvents`);
  url.searchParams.set(
    "input",
    typeof input === "string" ? input : JSON.stringify(input)
  );
  return handleWorkerRpcRequest(
    new Request(url, {
      headers: { authorization: `Bearer ${PROBE_TOKEN}` },
    }),
    createEnv()
  );
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
