import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { handleTelegramWebhook } from "./telegram";
import { TELEGRAM_COALESCE_QUIET_MS, waitUntilStore } from "./telegram-types";

const hoisted = vi.hoisted(() => ({
  directMessageHandler: undefined as
    | ((
        thread: unknown,
        message: unknown,
        channel: unknown,
        context: unknown
      ) => void)
    | undefined,
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

vi.mock("chat", () => ({
  Chat: class {
    readonly webhooks = {
      telegram: () => Promise.resolve(new Response(null, { status: 204 })),
    };

    onDirectMessage(handler: unknown) {
      hoisted.directMessageHandler = handler as NonNullable<
        typeof hoisted.directMessageHandler
      >;
    }

    onNewMention() {
      return;
    }

    onSubscribedMessage() {
      return;
    }
  },
}));

vi.mock("@chat-adapter/telegram", () => ({
  createTelegramAdapter: (options: unknown) => options,
}));

vi.mock("@chat-adapter/state-memory", () => ({
  createMemoryState: () => ({}),
}));

const DRY_RUN_ENV = {
  ENVIRONMENT: "development",
  TELEGRAM_BOT_TOKEN: "placeholder-bot-token",
  TELEGRAM_INGRESS_DRY_RUN: "1",
  TELEGRAM_WEBHOOK_SECRET_TOKEN: "placeholder-webhook-secret",
} as unknown as Env;

function createExecutionContext(): ExecutionContext {
  return {
    exports: {},
    passThroughOnException() {
      return;
    },
    props: undefined,
    waitUntil(_promise: Promise<unknown>) {
      return;
    },
  } as unknown as ExecutionContext;
}

interface FakeThread {
  readonly post: ReturnType<typeof vi.fn>;
}

/**
 * Drives one ingress fragment through the REAL Layer 1 coalescer (only the
 * chat-sdk adapters are mocked) and waits out the quiet window, so the
 * `telegram-ingress flush` log event and the dry-run reply come from the
 * actual dry-run code path.
 */
async function flushOneMessage(text: string): Promise<FakeThread> {
  const handler = hoisted.directMessageHandler;
  if (!handler) {
    throw new Error("direct-message handler was not registered");
  }
  const tasks: Promise<unknown>[] = [];
  const thread: FakeThread = {
    post: vi.fn(() => Promise.resolve()),
  };
  waitUntilStore.run(
    (task) => {
      tasks.push(task);
    },
    () => {
      handler(
        { channelId: "chan-1", id: "thread-1", post: thread.post },
        { text, threadId: "thread-1" },
        undefined,
        undefined
      );
    }
  );
  await vi.advanceTimersByTimeAsync(TELEGRAM_COALESCE_QUIET_MS + 100);
  await Promise.all(tasks);
  return thread;
}

function loggedIngressEvents(): Record<string, unknown>[] {
  return hoisted.logInfo.mock.calls
    .map(([event]) => event as Record<string, unknown>)
    .filter((event) => event.message === "telegram-ingress flush");
}

describe("telegram ingress dry-run preview (live coalescer path)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    hoisted.logInfo.mockClear();
    hoisted.logError.mockClear();
    await handleTelegramWebhook(
      new Request("https://worker.test/", {
        headers: {
          "x-telegram-bot-api-secret-token":
            DRY_RUN_ENV.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        },
        method: "POST",
      }),
      DRY_RUN_ENV,
      createExecutionContext()
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs a bounded 80-character preview and never the truncated tail", async () => {
    const tail = "TAILMARKER-DRYRUN-7c41";
    const text = `${"l".repeat(77)} ${tail}`;
    const thread = await flushOneMessage(text);

    const events = loggedIngressEvents();
    expect(events).toHaveLength(1);
    const event = events[0] ?? {};
    expect(event.dryRun).toBe(true);
    expect(event.textChars).toBe(text.length);
    expect(event.textPreview).toBe(`${"l".repeat(77)}...`);
    expect(String(event.textPreview)).toHaveLength(80);
    // The masked summary never carries text beyond the cut — not in the log
    // event payload and not in the dry-run reply posted back to the thread.
    expect(JSON.stringify(hoisted.logInfo.mock.calls)).not.toContain(tail);
    expect(thread.post).toHaveBeenCalledTimes(1);
    const reply = String(thread.post.mock.calls[0]?.[0]);
    expect(reply).toContain("ingress dry-run");
    expect(reply).toContain(`text: ${"l".repeat(77)}...`);
    expect(reply).not.toContain(tail);
  });

  it("logs text of at most 80 characters in full", async () => {
    const text = "m".repeat(80);
    const thread = await flushOneMessage(text);

    const events = loggedIngressEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.textPreview).toBe(text);
    const reply = String(thread.post.mock.calls[0]?.[0]);
    expect(reply).toContain(`text: ${text}`);
  });

  it("never logs message text fields other than the bounded preview", async () => {
    const text = `secret-ish content ${"n".repeat(120)}`;
    await flushOneMessage(text);

    const event = loggedIngressEvents()[0] ?? {};
    // Only counters + the bounded preview: no full-text field exists.
    expect(Object.keys(event).sort()).toEqual(
      [
        "dryRun",
        "hasImages",
        "imageCount",
        "imageMediaTypes",
        "key",
        "layer",
        "message",
        "messageCount",
        "subscribe",
        "textChars",
        "textPreview",
      ].sort()
    );
    expect(event.textChars).toBe(text.length);
    expect(JSON.stringify(event)).not.toContain(text);
  });
});
