import { fetchCloudflareDurableObject } from "@minpeter/pss-runtime/platform/cloudflare";
import { z } from "zod";

import { durableObjectName, type Env } from "./env";
import {
  type SessionIndexReader,
  type SessionListOptions,
  type SessionSearchOptions,
  SessionSearchResultSchema,
  SessionSummarySchema,
  type SessionTurnUpdate,
} from "./session-index";

export const SESSION_INDEX_OBJECT_NAME = "session-index:v1";
export const SESSION_INDEX_UPSERT_PATH = "/session-index/upsert";
export const SESSION_INDEX_LIST_PATH = "/session-index/list";
export const SESSION_INDEX_SEARCH_PATH = "/session-index/search";

const SESSION_INDEX_ORIGIN = "https://session-index.internal";

export const SessionIndexUpsertRequestSchema = z
  .object({
    assistantText: z.array(z.string()).optional(),
    channel: z.object({
      id: z.string(),
      kind: z.enum(["telegram", "tui"]),
    }),
    threadKey: z.string().min(1),
    userText: z.string(),
  })
  .strict();

export const SessionIndexListRequestSchema = z
  .object({
    excludeKey: z.string().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export const SessionIndexSearchRequestSchema = z
  .object({
    excludeKey: z.string().optional(),
    limit: z.number().int().positive().optional(),
    query: z.string(),
  })
  .strict();

const SessionIndexListResponseSchema = z
  .object({ sessions: z.array(SessionSummarySchema) })
  .strict();
const SessionIndexSearchResponseSchema = z
  .object({ sessions: z.array(SessionSearchResultSchema) })
  .strict();

export class SessionIndexClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionIndexClientError";
  }
}

export interface SessionIndexClient extends SessionIndexReader {
  upsert(update: SessionTurnUpdate): Promise<void>;
}

export function createSessionIndexClient(env: Env): SessionIndexClient {
  return {
    list: async (options: SessionListOptions = {}) => {
      const body = await postIndex(env, SESSION_INDEX_LIST_PATH, {
        ...(options.excludeKey ? { excludeKey: options.excludeKey } : {}),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      return SessionIndexListResponseSchema.parse(body).sessions;
    },
    search: async (query: string, options: SessionSearchOptions = {}) => {
      const body = await postIndex(env, SESSION_INDEX_SEARCH_PATH, {
        query,
        ...(options.excludeKey ? { excludeKey: options.excludeKey } : {}),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      return SessionIndexSearchResponseSchema.parse(body).sessions;
    },
    upsert: async (update: SessionTurnUpdate) => {
      await postIndex(env, SESSION_INDEX_UPSERT_PATH, {
        assistantText: update.assistantText ? [...update.assistantText] : [],
        channel: update.channel,
        threadKey: update.threadKey,
        userText: update.userText,
      });
    },
  };
}

async function postIndex(
  env: Env,
  path: string,
  payload: unknown
): Promise<unknown> {
  const response = await fetchCloudflareDurableObject({
    namespace: env.AGENT_DO,
    objectName: durableObjectName(SESSION_INDEX_OBJECT_NAME),
    request: new Request(`${SESSION_INDEX_ORIGIN}${path}`, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  });

  if (!response) {
    throw new SessionIndexClientError(
      "session index durable object unavailable"
    );
  }
  if (!response.ok) {
    throw new SessionIndexClientError(
      `session index request failed: ${response.status}`
    );
  }
  return await response.json();
}

export function isSessionIndexPath(pathname: string): boolean {
  return (
    pathname === SESSION_INDEX_UPSERT_PATH ||
    pathname === SESSION_INDEX_LIST_PATH ||
    pathname === SESSION_INDEX_SEARCH_PATH
  );
}
