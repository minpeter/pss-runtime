import { InMemoryCloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import { describe, expect, it } from "vitest";

import { AgentDurableObject } from "./agent-do";
import type { Env } from "./env";
import {
  SESSION_INDEX_LIST_PATH,
  SESSION_INDEX_SEARCH_PATH,
  SESSION_INDEX_UPSERT_PATH,
} from "./session-index-client";
import { createNodeTestSqlStorage } from "./session-index-test-sql";

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

function indexRequest(path: string, payload: unknown): Request {
  return new Request(`https://session-index.internal${path}`, {
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
