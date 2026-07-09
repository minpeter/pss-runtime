import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "./env";
import {
  collectTurnImageAttachments,
  collectTurnText,
  handleTelegramWebhook,
  isImageAttachment,
  replyToThread,
} from "./telegram";

const resolved = Promise.resolve();
const chatConstructors: unknown[] = [];

vi.mock("chat", () => ({
  Chat: class {
    readonly webhooks = {
      telegram: () => Promise.resolve(new Response(null, { status: 204 })),
    };

    constructor(options: unknown) {
      chatConstructors.push(options);
    }

    onDirectMessage() {
      return;
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

const env = {
  ENVIRONMENT: "development",
} as const;

class TestSpan {
  get isTraced(): boolean {
    return false;
  }

  end() {
    return;
  }

  setAttribute(_key: string, _value?: boolean | number | string) {
    return;
  }
}

const testTracing: Tracing = {
  enterSpan(_name, callback, ...args) {
    return callback(new TestSpan(), ...args);
  },
  Span: TestSpan,
  startActiveSpan(_name, callback, ...args) {
    return callback(new TestSpan(), ...args);
  },
};

describe("telegram conversation handling", () => {
  beforeEach(() => {
    chatConstructors.length = 0;
  });

  it("combines queued skipped text with the latest message", () => {
    expect(
      collectTurnText(
        { text: "latest" },
        { skipped: [{ text: "first" }, { text: "second" }] }
      )
    ).toBe("first\nsecond\nlatest");
  });

  it("treats telegram photos and image documents as image attachments", () => {
    expect(isImageAttachment({ type: "image" })).toBe(true);
    expect(isImageAttachment({ mimeType: "image/png", type: "file" })).toBe(
      true
    );
    expect(
      isImageAttachment({ mimeType: "application/pdf", type: "file" })
    ).toBe(false);
    expect(isImageAttachment({ type: "video" })).toBe(false);
  });

  it("materializes image attachments as base64 payloads", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await expect(
      collectTurnImageAttachments({
        attachments: [
          {
            fetchData: () => Promise.resolve(bytes),
            mimeType: "image/png",
            name: "shot.png",
            type: "image",
          },
          {
            data: new Uint8Array([9]),
            mimeType: "application/pdf",
            type: "file",
          },
        ],
        text: "caption",
      })
    ).resolves.toEqual([
      {
        dataBase64: btoa(String.fromCharCode(1, 2, 3, 4)),
        filename: "shot.png",
        mediaType: "image/png",
      },
    ]);
  });

  it("subscribes mention threads and posts development notice before replies", async () => {
    const posts: string[] = [];
    const scopes: Array<string | undefined> = [];
    const subscribe = vi.fn<() => Promise<void>>(() => resolved);

    await replyToThread({
      env,
      deliverTurn: (channelId, text, options) => {
        posts.push(`${channelId}:${text}`);
        scopes.push(options?.sessionScopeKey);
        return resolved;
      },
      message: { author: { userId: " user-1 " }, text: "hello" },
      subscribe: true,
      thread: {
        channelId: "channel-1",
        post: (text: string) => {
          posts.push(text);
          return resolved;
        },
        subscribe,
      },
    });

    expect(subscribe).toHaveBeenCalledOnce();
    expect(posts).toEqual(["🧪 DEVELOPMENT ENVIRONMENT", "channel-1:hello"]);
    expect(scopes).toEqual(["telegram:user:user-1"]);
  });

  it("delivers image-only messages with default jpeg media type", async () => {
    const delivered: Array<{
      attachments?: readonly { mediaType: string; dataBase64: string }[];
      text: string;
    }> = [];

    await replyToThread({
      env,
      deliverTurn: (_channelId, text, options) => {
        delivered.push({
          text,
          ...(options?.attachments
            ? { attachments: [...options.attachments] }
            : {}),
        });
        return resolved;
      },
      message: {
        attachments: [
          {
            data: new Uint8Array([10, 20]),
            type: "image",
          },
        ],
        text: "",
      },
      thread: {
        channelId: "channel-1",
        post: () => resolved,
        subscribe: () => resolved,
      },
    });

    expect(delivered).toEqual([
      {
        attachments: [
          {
            dataBase64: btoa(String.fromCharCode(10, 20)),
            mediaType: "image/jpeg",
          },
        ],
        text: "",
      },
    ]);
  });

  it("ignores empty messages with no text and no images", async () => {
    const deliverTurn = vi.fn();

    await replyToThread({
      env,
      deliverTurn,
      message: { text: "" },
      thread: {
        channelId: "channel-1",
        post: () => resolved,
        subscribe: () => resolved,
      },
    });

    expect(deliverTurn).not.toHaveBeenCalled();
  });

  it("does not post an assistant-output fallback after agent delivery", async () => {
    const posts: string[] = [];

    await replyToThread({
      env,
      deliverTurn: () => resolved,
      message: { text: "hello" },
      thread: {
        channelId: "channel-1",
        post: (text: string) => {
          posts.push(text);
          return resolved;
        },
        subscribe: () => resolved,
      },
    });

    expect(posts).toEqual(["🧪 DEVELOPMENT ENVIRONMENT"]);
  });

  it("posts the generic failure reply when tool-only delivery fails", async () => {
    const posts: string[] = [];

    await replyToThread({
      env,
      deliverTurn: async () => {
        await resolved;
        throw new Error("missing send_message");
      },
      message: { text: "hello" },
      thread: {
        channelId: "channel-1",
        post: (text: string) => {
          posts.push(text);
          return resolved;
        },
        subscribe: () => resolved,
      },
    });

    expect(posts).toEqual([
      "🧪 DEVELOPMENT ENVIRONMENT",
      "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
    ]);
  });

  it("does not leak internal failures to the chat thread", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const error = new Error("internal secret failure");
    const posts: string[] = [];

    await replyToThread({
      env,
      deliverTurn: async () => {
        await resolved;
        throw error;
      },
      message: { text: "hello" },
      thread: {
        channelId: "channel-1",
        post: (text: string) => {
          posts.push(text);
          return resolved;
        },
        subscribe: () => resolved,
      },
    });

    expect(posts).toEqual([
      "🧪 DEVELOPMENT ENVIRONMENT",
      "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
    ]);
    expect(errorLog).toHaveBeenCalledWith("telegram handler failed", error);
  });

  it("recreates the cached bot when Durable Object namespace changes", async () => {
    const context = createExecutionContext();
    const firstEnv = createWebhookEnv(createDurableObjectNamespace("first"));
    const secondEnv = createWebhookEnv(createDurableObjectNamespace("second"));

    await handleTelegramWebhook(
      new Request("https://worker.test/"),
      firstEnv,
      context
    );
    await handleTelegramWebhook(
      new Request("https://worker.test/"),
      secondEnv,
      context
    );

    expect(chatConstructors).toHaveLength(2);
  });
});

function createWebhookEnv(namespace: DurableObjectNamespace): Env {
  return {
    AGENT_DO: namespace,
    AI_API_KEY: "test-key",
    ENVIRONMENT: "production",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
  };
}

function createExecutionContext(): ExecutionContext {
  return {
    exports: {},
    passThroughOnException() {
      return;
    },
    props: undefined,
    tracing: testTracing,
    waitUntil(_promise: Promise<unknown>) {
      return;
    },
  };
}

function createDurableObjectNamespace(label: string): DurableObjectNamespace {
  const namespace: DurableObjectNamespace = {
    get(_id: DurableObjectId) {
      throw new Error(`${label} namespace should not be fetched`);
    },
    getByName(_name: string) {
      throw new Error(`${label} namespace should not be fetched`);
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
      return createDurableObjectId(`${label}-unique`);
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
