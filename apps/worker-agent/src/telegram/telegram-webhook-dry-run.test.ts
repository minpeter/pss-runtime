import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { handleTelegramWebhook } from "./telegram";

/**
 * Scripted Telegram webhook fixture for the ingress dry-run boundary
 * (VAL-WORKER-042): unlike telegram-dry-run.test.ts, which mocks the chat
 * SDK, this fixture drives the REAL chat SDK + REAL @chat-adapter/telegram
 * webhook handler with global fetch replaced by a loopback recorder, so the
 * secret check, update parsing, fragment coalesce, and dry-run reply all run
 * through production code.
 */

const hoisted = vi.hoisted(() => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("../worker-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker-log")>();
  return {
    ...actual,
    logError: hoisted.logError,
    logInfo: hoisted.logInfo,
  };
});

const TELEGRAM_SENTINEL_BASE = "http://127.0.0.1:8793";
const PROVIDER_SENTINEL_BASE = "http://127.0.0.1:9/provider-sentinel";
const WEBHOOK_SECRET = "placeholder_webhook_secret";
const BOT_TOKEN = "placeholder-bot-token";
const SEND_MESSAGE_METHOD = "sendMessage";

interface RecordedCall {
  readonly body: string;
  readonly method: string;
  readonly url: string;
}

function telegramMethodOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

/** Telegram-shaped recorder: canned OK payloads, every call logged. */
function recordTelegramApi(calls: RecordedCall[]) {
  return vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : undefined;
      const url = String(request ? request.url : input);
      let body = "";
      if (init?.body) {
        body = String(init.body);
      } else if (request) {
        body = await request.clone().text();
      }
      calls.push({
        body,
        method: init?.method ?? request?.method ?? "GET",
        url,
      });
      // Superset OK payload: satisfies getMe (id/username) and sendMessage
      // (message_id/chat) without a real Telegram round-trip.
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            chat: { id: 4242, type: "private" },
            date: 1_767_225_600,
            first_name: "Recorder",
            id: 9001,
            is_bot: true,
            message_id: 1,
            text: "ok",
            username: "placeholder_bot",
          },
        }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        }
      );
    }
  );
}

/** A fresh namespace also forces a cold bot cache for every test. */
function createAgentDoProbe(): {
  readonly calls: number;
  readonly namespace: DurableObjectNamespace;
} {
  const probe = { calls: 0 };
  return {
    get calls() {
      return probe.calls;
    },
    namespace: {
      get() {
        probe.calls += 1;
        throw new Error("AGENT_DO get() must not run in ingress dry-run");
      },
      getByName() {
        probe.calls += 1;
        throw new Error("AGENT_DO getByName() must not run in ingress dry-run");
      },
      idFromName(name: string) {
        probe.calls += 1;
        throw new Error(
          `AGENT_DO idFromName(${name}) must not run in ingress dry-run`
        );
      },
    } as unknown as DurableObjectNamespace,
  };
}

function createDryRunEnv(agentDo: DurableObjectNamespace): Env {
  return {
    AGENT_DO: agentDo,
    AI_API_KEY: "sk-placeholder-dry-run",
    AI_BASE_URL: PROVIDER_SENTINEL_BASE,
    AI_MODEL: "placeholder-model",
    ENVIRONMENT: "development",
    TELEGRAM_API_BASE_URL: TELEGRAM_SENTINEL_BASE,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_INGRESS_DRY_RUN: "1",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: WEBHOOK_SECRET,
  } as unknown as Env;
}

function createExecutionContext(tasks: Promise<unknown>[]): ExecutionContext {
  return {
    exports: {},
    passThroughOnException() {
      return;
    },
    props: undefined,
    waitUntil(promise: Promise<unknown>) {
      tasks.push(promise);
    },
  } as unknown as ExecutionContext;
}

function scriptedUpdate(text: string): string {
  return JSON.stringify({
    message: {
      chat: {
        first_name: "Probe",
        id: 4242,
        type: "private",
        username: "probe_user",
      },
      date: 1_800_000_000,
      from: {
        first_name: "Probe",
        id: 4242,
        is_bot: false,
        username: "probe_user",
      },
      message_id: 7,
      text,
    },
    update_id: 900_001,
  });
}

function webhookRequest(body: string, secret?: string): Request {
  return new Request("https://worker.test/telegram", {
    body,
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
    },
    method: "POST",
  });
}

async function flushIngress(tasks: Promise<unknown>[]): Promise<void> {
  // The coalescer registers its quiet-window work via waitUntil during the
  // webhook request; awaiting those tasks waits out the window and the flush.
  // Loop because awaiting one task can register a follow-up task.
  let processed = 0;
  while (processed < tasks.length) {
    const batch = tasks.slice(processed);
    processed = tasks.length;
    await Promise.all(batch);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telegram webhook ingress dry-run (real adapter, recorded fetch)", () => {
  it("answers a scripted update with the local Layer-1 dry-run summary and " +
    "zero agent delivery or provider requests", {
    timeout: 30_000,
  }, async () => {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", recordTelegramApi(calls));
    const agentDo = createAgentDoProbe();
    const tasks: Promise<unknown>[] = [];
    const text = "dry run probe message";

    const response = await handleTelegramWebhook(
      webhookRequest(scriptedUpdate(text), WEBHOOK_SECRET),
      {
        ...createDryRunEnv(agentDo.namespace),
        TELEGRAM_WEBHOOK_SECRET_TOKEN: ` ${WEBHOOK_SECRET} `,
      },
      createExecutionContext(tasks)
    );
    expect(response.status).toBeLessThan(300);
    await flushIngress(tasks);

    // Every outbound call hit the loopback sentinel base configured through
    // TELEGRAM_API_BASE_URL — never the real api.telegram.org.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith(`${TELEGRAM_SENTINEL_BASE}/bot`)).toBe(true);
    }
    // Webhook-inbound only: no long-polling.
    expect(
      calls.filter((call) => telegramMethodOf(call.url) === "getUpdates")
    ).toEqual([]);
    // No provider (model) request of any kind.
    expect(
      calls.filter((call) => call.url.startsWith(PROVIDER_SENTINEL_BASE))
    ).toEqual([]);
    // No agent delivery: the Durable Object was never touched.
    expect(agentDo.calls).toBe(0);

    // The dry-run summary reply went out via sendMessage, carrying the
    // Layer-1-only marker, fragment/image/text counters, and the preview.
    const sends = calls.filter(
      (call) => telegramMethodOf(call.url) === SEND_MESSAGE_METHOD
    );
    expect(sends).toHaveLength(1);
    const sendBody = sends[0]?.body ?? "";
    expect(sendBody).toContain("Layer 1 only");
    expect(sendBody).toContain("agent skipped");
    expect(sendBody).toContain("fragments=1");
    expect(sendBody).toContain("images=0");
    expect(sendBody).toContain(`textChars=${text.length}`);
    expect(sendBody).toContain(text);

    // The structured ingress log event carries the same bounded summary.
    const flushes = hoisted.logInfo.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .filter((event) => event.message === "telegram-ingress flush");
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toMatchObject({
      dryRun: true,
      textChars: text.length,
      textPreview: text,
    });
  });

  it.each([undefined, TELEGRAM_SENTINEL_BASE])(
    "rejects a missing secret before any egress with API base %s",
    async (apiBaseUrl) => {
      const calls: RecordedCall[] = [];
      vi.stubGlobal("fetch", recordTelegramApi(calls));
      const agentDo = createAgentDoProbe();
      const tasks: Promise<unknown>[] = [];

      const response = await handleTelegramWebhook(
        webhookRequest(scriptedUpdate("unauthorized probe")),
        {
          ...createDryRunEnv(agentDo.namespace),
          TELEGRAM_API_BASE_URL: apiBaseUrl,
        },
        createExecutionContext(tasks)
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe(
        "text/plain;charset=UTF-8"
      );
      expect(await response.text()).toBe("Invalid secret token");
      await flushIngress(tasks);
      expect(calls).toEqual([]);
      expect(tasks).toEqual([]);
      expect(agentDo.calls).toBe(0);
    }
  );

  it.each([undefined, TELEGRAM_SENTINEL_BASE])(
    "rejects an incorrect secret before any egress with API base %s",
    async (apiBaseUrl) => {
      const calls: RecordedCall[] = [];
      vi.stubGlobal("fetch", recordTelegramApi(calls));
      const agentDo = createAgentDoProbe();
      const tasks: Promise<unknown>[] = [];

      const response = await handleTelegramWebhook(
        webhookRequest(
          scriptedUpdate("unauthorized probe"),
          "x".repeat(WEBHOOK_SECRET.length)
        ),
        {
          ...createDryRunEnv(agentDo.namespace),
          TELEGRAM_API_BASE_URL: apiBaseUrl,
        },
        createExecutionContext(tasks)
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toBe(
        "text/plain;charset=UTF-8"
      );
      expect(await response.text()).toBe("Invalid secret token");
      await flushIngress(tasks);
      expect(calls).toEqual([]);
      expect(tasks).toEqual([]);
      expect(agentDo.calls).toBe(0);
    }
  );
});
