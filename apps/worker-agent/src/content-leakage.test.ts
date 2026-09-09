import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "./env";
import worker from "./index";

/**
 * Cross-surface negative-response battery (VAL-WORKER-045): every non-2xx
 * response on the public surface is bounded and leaks nothing. Each probe
 * carries distinctive sentinel values (channel id, message text, bearer
 * token, webhook secret, Durable Object stub internals) and every captured
 * body is audited for echoes of those sentinels, the configured secret
 * values, and stack-trace markers. The battery runs twice with two
 * different placeholder secret sets and the captured statuses and bodies
 * must be byte-identical, proving no response varies with secret values.
 */

const ORIGIN = "https://worker.test";
const MAX_ERROR_BODY_BYTES = 512;

const SENTINELS = {
  bearer: "leak-sentinel-wrong-bearer",
  channelId: "leak-sentinel-channel-id",
  cursor: "leak-sentinel-cursor",
  extraKey: "leak-sentinel-extra-key",
  pathProbe: "leak-sentinel-long-path",
  stub: "leak-sentinel-stub-internal",
  text: "leak-sentinel-message-text",
  wrongSecret: "leak-sentinel-wrong-webhook-secret",
} as const;

const FIXED_LITERAL_BODIES = new Set([
  "unauthorized",
  "channel required",
  "invalid session event stream",
  "method not allowed",
  "agent durable object unavailable",
  // The Telegram adapter's fixed webhook rejection body.
  "Invalid secret token",
]);

const STACK_MARKER_PATTERNS = [
  /(^|\n)\s*at\s+[\w$.<>]+\s*\(/u,
  /\.ts:\d+/u,
  /\bError:\s/u,
];
const BEARER_VALUE_PATTERN = /Bearer\s+\S/u;

const durableObjectMock = vi.hoisted(() => ({
  requests: [] as Request[],
  respond: (_request: Request): Promise<Response | undefined> =>
    Promise.resolve(Response.json({ events: [] })),
}));

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

interface SecretSet {
  readonly aiApiKey: string;
  readonly botToken: string;
  readonly tuiToken: string;
  readonly webhookSecret: string;
}

const SECRETS_ALPHA: SecretSet = {
  aiApiKey: "sk-placeholder-leak-alpha",
  botToken: "placeholder-bot-token-alpha",
  tuiToken: "placeholder-tui-token-alpha",
  webhookSecret: "placeholder_webhook_secret_alpha",
};

const SECRETS_BETA: SecretSet = {
  aiApiKey: "sk-placeholder-leak-beta",
  botToken: "placeholder-bot-token-beta",
  tuiToken: "placeholder-tui-token-beta",
  webhookSecret: "placeholder_webhook_secret_beta",
};

interface RecordedEgress {
  readonly method: string;
  readonly url: string;
}

interface BatteryResult {
  readonly body: string;
  readonly name: string;
  readonly status: number;
}

/** Canned Telegram Bot API OK payload; every call is recorded. */
function recordTelegramApi(outbound: RecordedEgress[]) {
  return vi.fn(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : undefined;
      outbound.push({
        method: init?.method ?? request?.method ?? "GET",
        url: String(request ? request.url : input),
      });
      return Promise.resolve(
        Response.json({
          ok: true,
          result: {
            id: 9001,
            is_bot: true,
            username: "placeholder_bot",
          },
        })
      );
    }
  );
}

function createEnv(secrets: SecretSet): Env {
  return {
    AGENT_DO: {
      get: () => {
        throw new Error("namespace is mocked at the fetch seam");
      },
      idFromName: (name: string) => ({ name, toString: () => name }),
    } as unknown as DurableObjectNamespace,
    AI_API_KEY: secrets.aiApiKey,
    AI_BASE_URL: "http://127.0.0.1:9/unreachable",
    ENVIRONMENT: "production",
    TELEGRAM_BOT_TOKEN: secrets.botToken,
    TELEGRAM_WEBHOOK_SECRET_TOKEN: secrets.webhookSecret,
    WORKER_AGENT_TUI_TOKEN: secrets.tuiToken,
  } as unknown as Env;
}

function createBrokenEnv(secrets: SecretSet): Env {
  return {
    ...createEnv(secrets),
    AGENT_DO: undefined,
    ENVIRONMENT: "staging",
  } as unknown as Env;
}

const ctx = {
  waitUntil() {
    // no-op: negative probes schedule no background work
  },
};

function scriptedUpdate(text: string): string {
  return JSON.stringify({
    message: {
      chat: { id: 4242, type: "private" },
      date: 1_800_000_000,
      message_id: 7,
      text,
    },
    update_id: 900_001,
  });
}

function rejectWithSentinel(): Promise<Response | undefined> {
  return Promise.reject(
    new Error(`stub down ${SENTINELS.stub} at /secret/internal/path.ts:42`)
  );
}

/**
 * The full negative battery: every reachable non-2xx on the public surface,
 * each probe laden with sentinel values that must never be echoed. The 502
 * legs drive the mocked Durable Object seam into rejection; a live local
 * worker cannot produce them without breaking its binding.
 */
async function runNegativeBattery(
  secrets: SecretSet
): Promise<BatteryResult[]> {
  const env = createEnv(secrets);
  const brokenEnv = createBrokenEnv(secrets);
  const results: BatteryResult[] = [];
  const bearer = { authorization: `Bearer ${secrets.tuiToken}` };
  const probe = (
    path: string,
    init: RequestInit = {},
    targetEnv: Env = env
  ): Promise<Response> =>
    worker.fetch(
      new Request(`${ORIGIN}${path}`, init),
      targetEnv,
      ctx as unknown as ExecutionContext
    );
  const record = async (name: string, response: Promise<Response>) => {
    const settled = await response;
    results.push({
      body: await settled.text(),
      name,
      status: settled.status,
    });
  };

  await record(
    "health-post",
    probe("/healthz", { body: SENTINELS.text, method: "POST" })
  );
  await record("health-broken-bindings", probe("/healthz", {}, brokenEnv));
  await record(
    "sse-post",
    probe("/session/events?channel=tui%3Alocal", {
      headers: bearer,
      method: "POST",
    })
  );
  await record("sse-no-auth", probe("/session/events?channel=tui%3Alocal"));
  await record(
    "sse-wrong-bearer",
    probe("/session/events?channel=tui%3Alocal", {
      headers: { authorization: `Bearer ${SENTINELS.bearer}` },
    })
  );
  await record("sse-no-channel", probe("/session/events", { headers: bearer }));
  await record(
    "sse-bad-channel",
    probe(
      `/session/events?channel=${encodeURIComponent(
        `web:${SENTINELS.channelId}`
      )}`,
      { headers: bearer }
    )
  );
  await record(
    "sse-bad-cursor",
    probe(`/session/events?channel=tui%3Alocal&after=${SENTINELS.cursor}`, {
      headers: bearer,
    })
  );

  durableObjectMock.respond = rejectWithSentinel;
  await record(
    "sse-do-unreachable",
    probe("/session/events?channel=tui%3Alocal", { headers: bearer })
  );
  durableObjectMock.respond = () =>
    Promise.resolve(Response.json({ events: [] }));

  const badInput = encodeURIComponent(
    JSON.stringify({
      [SENTINELS.extraKey]: 1,
      channel: { id: SENTINELS.channelId, kind: "sms" },
      limit: 0,
    })
  );
  await record(
    "trpc-bad-input",
    probe(`/trpc/session.replayEvents?input=${badInput}`, {
      headers: bearer,
    })
  );
  // Attacker-controlled unrecognized keys must not inflate the envelope:
  // fifty extra keys answer with the same fixed bounded message.
  const inflatedInput = encodeURIComponent(
    JSON.stringify({
      channel: { id: "local", kind: "tui" },
      ...Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [`padding-key-${index}`, 0])
      ),
    })
  );
  await record(
    "trpc-inflated-input",
    probe(`/trpc/session.replayEvents?input=${inflatedInput}`, {
      headers: bearer,
    })
  );
  const validReplayInput = encodeURIComponent(
    JSON.stringify({ channel: { id: "local", kind: "tui" } })
  );
  await record(
    "trpc-wrong-bearer",
    probe(`/trpc/session.replayEvents?input=${validReplayInput}`, {
      headers: { authorization: `Bearer ${SENTINELS.bearer}` },
    })
  );
  await record(
    "trpc-unknown-procedure",
    probe("/trpc/session.doesNotExist?input=%7B%7D", { headers: bearer })
  );
  // A 2000+ character attacker-controlled procedure path must still answer
  // with the fixed bounded NOT_FOUND envelope: no path echo in the message
  // and no data.path field.
  const longPath = `session.${"a".repeat(1000)}${SENTINELS.pathProbe}${"b".repeat(
    1000
  )}`;
  await record(
    "trpc-long-path-not-found",
    probe(`/trpc/${longPath}?input=%7B%7D`, { headers: bearer })
  );
  await record(
    "trpc-query-post",
    probe("/trpc/session.replayEvents", {
      body: JSON.stringify({ channel: { id: "local", kind: "tui" } }),
      headers: { ...bearer, "content-type": "application/json" },
      method: "POST",
    })
  );
  await record(
    "trpc-unsupported-media-type",
    probe("/trpc/session.submitTurn", {
      body: SENTINELS.text,
      headers: {
        "content-type": `text/${SENTINELS.pathProbe}${"x".repeat(6000)}`,
      },
      method: "POST",
    })
  );
  await record(
    "trpc-malformed-json",
    probe("/trpc/session.submitTurn", {
      body: SENTINELS.text,
      headers: { ...bearer, "content-type": "application/json" },
      method: "POST",
    })
  );
  await record(
    "trpc-malformed-replay-input",
    probe(
      `/trpc/session.replayEvents?input=${encodeURIComponent(SENTINELS.text)}`,
      {
        headers: bearer,
      }
    )
  );

  durableObjectMock.respond = rejectWithSentinel;
  await record(
    "trpc-submit-do-unreachable",
    probe("/trpc/session.submitTurn", {
      body: JSON.stringify({
        channel: { id: "local", kind: "tui" },
        idempotencyKey: "leak-sentinel-idempotency-key",
        text: SENTINELS.text,
      }),
      headers: { ...bearer, "content-type": "application/json" },
      method: "POST",
    })
  );
  durableObjectMock.respond = () =>
    Promise.resolve(Response.json({ events: [] }));

  const update = scriptedUpdate(SENTINELS.text);
  await record(
    "telegram-no-secret",
    probe("/telegram", {
      body: update,
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  await record(
    "telegram-wrong-secret",
    probe("/telegram", {
      body: update,
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": SENTINELS.wrongSecret,
      },
      method: "POST",
    })
  );
  await record(
    "unknown-route-get",
    probe("/definitely-not-a-route", { headers: bearer })
  );

  return results;
}

const EXPECTED_STATUSES: Record<string, number> = {
  "health-broken-bindings": 503,
  "health-post": 405,
  "sse-bad-channel": 400,
  "sse-bad-cursor": 400,
  "sse-do-unreachable": 502,
  "sse-no-auth": 401,
  "sse-no-channel": 400,
  "sse-post": 405,
  "sse-wrong-bearer": 401,
  "telegram-no-secret": 401,
  "telegram-wrong-secret": 401,
  "trpc-bad-input": 400,
  "trpc-inflated-input": 400,
  "trpc-long-path-not-found": 404,
  "trpc-query-post": 405,
  "trpc-unsupported-media-type": 415,
  "trpc-malformed-json": 400,
  "trpc-malformed-replay-input": 400,
  "trpc-submit-do-unreachable": 502,
  "trpc-unknown-procedure": 404,
  "trpc-wrong-bearer": 401,
  "unknown-route-get": 401,
};

/** Classify a body as a fixed literal, bounded health JSON, or tRPC envelope. */
function classifyBody(body: string): "literal" | "health" | "trpc-envelope" {
  if (FIXED_LITERAL_BODIES.has(body)) {
    return "literal";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `non-2xx body is neither a fixed literal nor JSON: ${body}`
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`non-2xx JSON body is not an object: ${body}`);
  }
  const keys = Object.keys(parsed).sort();
  if ("error" in parsed && keys.length === 1) {
    const error = (parsed as { error: unknown }).error;
    if (error === "unavailable" || error === "method not allowed") {
      return "health";
    }
  }
  const envelope = (parsed as { error?: unknown }).error;
  if (typeof envelope !== "object" || envelope === null) {
    throw new Error(`tRPC error envelope missing: ${body}`);
  }
  const { code, data, message } = envelope as {
    code?: unknown;
    data?: unknown;
    message?: unknown;
  };
  if (
    typeof message !== "string" ||
    message.length > 256 ||
    typeof code !== "number"
  ) {
    throw new Error(`tRPC envelope is not bounded: ${body}`);
  }
  const envelopeData = data as { code?: unknown; httpStatus?: unknown };
  if (
    typeof envelopeData?.code !== "string" ||
    typeof envelopeData.httpStatus !== "number"
  ) {
    throw new Error(`tRPC envelope data is malformed: ${body}`);
  }
  if ("stack" in envelope || "cause" in envelope) {
    throw new Error(`tRPC envelope carries stack/cause: ${body}`);
  }
  return "trpc-envelope";
}

function auditBody(
  result: BatteryResult,
  secrets: SecretSet,
  validToken: string
): void {
  const { body, name } = result;
  expect(
    Buffer.byteLength(body),
    `${name} body exceeds ${MAX_ERROR_BODY_BYTES} bytes`
  ).toBeLessThanOrEqual(MAX_ERROR_BODY_BYTES);

  const secretValues = [
    secrets.aiApiKey,
    secrets.botToken,
    secrets.webhookSecret,
    validToken,
  ];
  for (const value of [...Object.values(SENTINELS), ...secretValues]) {
    expect(body, `${name} echoes a sentinel or secret value`).not.toContain(
      value
    );
  }
  expect(body, `${name} echoes a bearer header`).not.toMatch(
    BEARER_VALUE_PATTERN
  );
  for (const pattern of STACK_MARKER_PATTERNS) {
    expect(body, `${name} carries a stack marker`).not.toMatch(pattern);
  }
  classifyBody(body);
}

beforeEach(() => {
  durableObjectMock.requests.length = 0;
  durableObjectMock.respond = () =>
    Promise.resolve(Response.json({ events: [] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content leakage battery (VAL-WORKER-045)", () => {
  it("every non-2xx response is a bounded fixed literal or tRPC envelope with zero echo", async () => {
    const outbound: RecordedEgress[] = [];
    vi.stubGlobal("fetch", recordTelegramApi(outbound));

    const results = await runNegativeBattery(SECRETS_ALPHA);

    expect(Object.fromEntries(results.map((r) => [r.name, r.status]))).toEqual(
      EXPECTED_STATUSES
    );
    for (const result of results) {
      auditBody(result, SECRETS_ALPHA, SECRETS_ALPHA.tuiToken);
    }
    // NOT_FOUND envelopes carry the fixed literal message and no data.path,
    // so the attacker-controlled URL path is never echoed back.
    for (const name of ["trpc-unknown-procedure", "trpc-long-path-not-found"]) {
      const result = results.find((entry) => entry.name === name);
      if (!result) {
        throw new Error(`missing battery result ${name}`);
      }
      const envelope = (
        JSON.parse(result.body) as {
          error: {
            data?: Record<string, unknown>;
            message?: unknown;
          };
        }
      ).error;
      expect(envelope.message, `${name} message`).toBe("not found");
      expect(envelope.data, `${name} data.path`).not.toHaveProperty("path");
    }
    // Unauthorized webhooks must not initialize the adapter or cause egress.
    expect(outbound).toEqual([]);
  });

  it("no error body varies with the configured secret values", async () => {
    vi.stubGlobal("fetch", recordTelegramApi([]));

    const alpha = await runNegativeBattery(SECRETS_ALPHA);
    const beta = await runNegativeBattery(SECRETS_BETA);

    expect(beta).toEqual(alpha);
    for (const result of beta) {
      auditBody(result, SECRETS_BETA, SECRETS_BETA.tuiToken);
    }
  });
});
