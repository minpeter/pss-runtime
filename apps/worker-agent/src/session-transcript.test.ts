import type { StoredThread, ThreadStore } from "@minpeter/pss-runtime";
import { describe, expect, it } from "vitest";

import {
  createThreadStoreSessionTranscriptReader,
  DEFAULT_SESSION_READ_LIMIT,
} from "./session-transcript";

async function commitHistory(
  store: ThreadStore,
  threadKey: string,
  history: readonly unknown[]
): Promise<void> {
  const committed = await store.commit(
    threadKey,
    { state: { history, schemaVersion: 1 } },
    { expectedVersion: null }
  );
  expect(committed.ok).toBe(true);
}

class FakeThreadStore implements ThreadStore {
  readonly #threads = new Map<string, StoredThread>();

  commit(
    key: string,
    next: { readonly state: unknown },
    options: { readonly expectedVersion: string | null }
  ) {
    const current = this.#threads.get(key);
    const currentVersion = current?.version ?? null;
    if (options.expectedVersion !== currentVersion) {
      return Promise.resolve({
        ok: false as const,
        reason: "conflict" as const,
      });
    }
    const version = String(Number(current?.version ?? "0") + 1);
    this.#threads.set(key, { state: next.state, version });
    return Promise.resolve({ ok: true as const, version });
  }

  delete(key: string): Promise<void> {
    this.#threads.delete(key);
    return Promise.resolve();
  }

  load(key: string): Promise<StoredThread | null> {
    return Promise.resolve(this.#threads.get(key) ?? null);
  }
}

describe("session transcript reader", () => {
  it("reads user text and send_message tool-call text as a compact transcript", async () => {
    const store = new FakeThreadStore();
    await commitHistory(store, "telegram:a", [
      { role: "user", content: "deploy 얘기 뭐였지?" },
      {
        role: "assistant",
        content: [
          {
            input: { text: "배포는 금요일 오전으로 잡자고 했어." },
            toolCallId: "call-1",
            toolName: "send_message",
            type: "tool-call",
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            output: { type: "json", value: { delivered: true } },
            toolCallId: "call-1",
            toolName: "send_message",
            type: "tool-result",
          },
        ],
      },
    ]);
    const reader = createThreadStoreSessionTranscriptReader({
      resolveThreadKey: (conversationKey) => conversationKey,
      store,
    });

    const transcript = await reader.read("telegram:a");

    expect(transcript).toEqual({
      conversationKey: "telegram:a",
      hasMore: false,
      messageCount: 2,
      messages: [
        { index: 0, role: "user", text: "deploy 얘기 뭐였지?" },
        {
          index: 1,
          role: "assistant",
          text: "배포는 금요일 오전으로 잡자고 했어.",
        },
      ],
    });
  });

  it("returns the latest messages with an older-page cursor when over the default limit", async () => {
    const store = new FakeThreadStore();
    await commitHistory(
      store,
      "tui:local",
      Array.from({ length: DEFAULT_SESSION_READ_LIMIT + 1 }, (_, index) => ({
        content: `message ${index}`,
        role: "user",
      }))
    );
    const reader = createThreadStoreSessionTranscriptReader({
      resolveThreadKey: (conversationKey) => conversationKey,
      store,
    });

    const transcript = await reader.read("tui:local");

    expect(transcript?.messages).toHaveLength(DEFAULT_SESSION_READ_LIMIT);
    expect(transcript?.messages[0]?.text).toBe("message 1");
    expect(transcript?.hasMore).toBe(true);
    expect(transcript?.nextCursor).toBe(1);
  });
});
