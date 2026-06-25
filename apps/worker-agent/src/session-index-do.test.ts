import {
  DurableObjectSqliteThreadStore,
  InMemoryCloudflareDurableObjectStorage,
} from "@minpeter/pss-runtime/cloudflare";
import { describe, expect, it } from "vitest";

import { AgentDurableObject } from "./agent-do";
import type { Env } from "./env";
import {
  SESSION_INDEX_LIST_PATH,
  SESSION_INDEX_SEARCH_PATH,
  SESSION_INDEX_UPSERT_PATH,
} from "./session-index-client";
import { createNodeTestSqlStorage } from "./session-index-test-sql";
import { SESSION_TRANSCRIPT_READ_PATH } from "./session-transcript-client";

function createIndexDurableObject() {
  const storage = new InMemoryCloudflareDurableObjectStorage({
    sql: createNodeTestSqlStorage(),
  });
  const env = {
    AGENT_DO: undefined,
    AI_API_KEY: "test-key",
    ENVIRONMENT: "development",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
  } as unknown as Env;
  const state = { storage } as unknown as DurableObjectState;
  return new AgentDurableObject(state, env);
}

async function createDurableObjectWithThread(history: readonly unknown[]) {
  const storage = new InMemoryCloudflareDurableObjectStorage({
    sql: createNodeTestSqlStorage(),
  });
  const threadStore = new DurableObjectSqliteThreadStore(
    storage,
    "pss-runtime"
  );
  const committed = await threadStore.commit(
    "default",
    { state: { history, schemaVersion: 1 } },
    { expectedVersion: null }
  );
  expect(committed.ok).toBe(true);

  const env = {
    AGENT_DO: undefined,
    AI_API_KEY: "test-key",
    ENVIRONMENT: "development",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "secret",
  } as unknown as Env;
  const state = { storage } as unknown as DurableObjectState;
  return new AgentDurableObject(state, env);
}

function indexRequest(path: string, payload: unknown): Request {
  return new Request(`https://session-index.internal${path}`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function transcriptRequest(payload: unknown): Request {
  return new Request(`https://agent.internal${SESSION_TRANSCRIPT_READ_PATH}`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("AgentDurableObject session-index routes", () => {
  it("upserts then lists and searches indexed sessions", async () => {
    const object = createIndexDurableObject();

    await object.fetch(
      indexRequest(SESSION_INDEX_UPSERT_PATH, {
        assistantText: ["sure, here is the migration plan"],
        channel: { id: "a", kind: "telegram" },
        userText: "help me plan the database migration",
      })
    );
    await object.fetch(
      indexRequest(SESSION_INDEX_UPSERT_PATH, {
        channel: { id: "b", kind: "tui" },
        userText: "what is the weather",
      })
    );

    const listResponse = await object.fetch(
      indexRequest(SESSION_INDEX_LIST_PATH, {})
    );
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      sessions: { conversationKey: string }[];
    };
    expect(listBody.sessions).toHaveLength(2);

    const searchResponse = await object.fetch(
      indexRequest(SESSION_INDEX_SEARCH_PATH, { query: "database migration" })
    );
    const searchBody = (await searchResponse.json()) as {
      sessions: { conversationKey: string }[];
    };
    expect(searchBody.sessions).toHaveLength(1);
    expect(searchBody.sessions[0]?.conversationKey).toBe("telegram:a");
  });

  it("rejects malformed index payloads", async () => {
    const object = createIndexDurableObject();
    const response = await object.fetch(
      indexRequest(SESSION_INDEX_UPSERT_PATH, { channel: { id: "a" } })
    );
    expect(response.status).toBe(400);
  });
});

describe("AgentDurableObject session transcript route", () => {
  it("reads a capped transcript from the durable thread", async () => {
    const object = await createDurableObjectWithThread([
      { role: "user", content: "지난번 주제 뭐였지?" },
      {
        role: "assistant",
        content: [
          {
            input: { text: "세션 검색 다음에 read_session을 붙이기로 했어." },
            toolCallId: "call-1",
            toolName: "send_message",
            type: "tool-call",
          },
        ],
      },
    ]);

    const response = await object.fetch(
      transcriptRequest({ conversationKey: "telegram:a" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      conversationKey: "telegram:a",
      found: true,
      hasMore: false,
      messageCount: 2,
      messages: [
        { index: 0, role: "user", text: "지난번 주제 뭐였지?" },
        {
          index: 1,
          role: "assistant",
          text: "세션 검색 다음에 read_session을 붙이기로 했어.",
        },
      ],
    });
  });
});
