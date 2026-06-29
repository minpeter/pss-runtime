import type {
  SessionIndexStore,
  SessionListOptions,
  SessionReadAuthorizationOptions,
  SessionSearchOptions,
} from "./session-index";
import {
  SESSION_INDEX_CAN_READ_PATH,
  SESSION_INDEX_LIST_PATH,
  SESSION_INDEX_SEARCH_PATH,
  SESSION_INDEX_UPSERT_PATH,
  SessionIndexCanReadRequestSchema,
  SessionIndexListRequestSchema,
  SessionIndexSearchRequestSchema,
  SessionIndexUpsertRequestSchema,
} from "./session-index-client";

export interface HandleSessionIndexRequestOptions {
  readonly pathname: string;
  readonly request: Request;
  readonly store: SessionIndexStore;
}

type JsonBodyResult =
  | { readonly ok: false }
  | { readonly ok: true; readonly value: unknown };

export async function handleSessionIndexRequest({
  pathname,
  request,
  store,
}: HandleSessionIndexRequestOptions): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return new Response("invalid json", { status: 400 });
  }

  switch (pathname) {
    case SESSION_INDEX_UPSERT_PATH:
      return await handleUpsert(store, body.value);
    case SESSION_INDEX_CAN_READ_PATH:
      return await handleCanRead(store, body.value);
    case SESSION_INDEX_LIST_PATH:
      return await handleList(store, body.value);
    case SESSION_INDEX_SEARCH_PATH:
      return await handleSearch(store, body.value);
    default:
      return new Response("not found", { status: 404 });
  }
}

async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
}

async function handleUpsert(
  store: SessionIndexStore,
  body: unknown
): Promise<Response> {
  const parsed = SessionIndexUpsertRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response("invalid upsert", { status: 400 });
  }

  await store.upsert({
    assistantText: parsed.data.assistantText ?? [],
    channel: parsed.data.channel,
    sessionScopeKey: parsed.data.sessionScopeKey,
    threadKey: parsed.data.threadKey,
    userText: parsed.data.userText,
  });
  return Response.json({ ok: true });
}

async function handleCanRead(
  store: SessionIndexStore,
  body: unknown
): Promise<Response> {
  const parsed = SessionIndexCanReadRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response("invalid can-read", { status: 400 });
  }

  const canRead = await store.canRead(
    parsed.data.conversationKey,
    readAuthorizationOptions(parsed.data)
  );
  return Response.json({ canRead });
}

async function handleList(
  store: SessionIndexStore,
  body: unknown
): Promise<Response> {
  const parsed = SessionIndexListRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response("invalid list", { status: 400 });
  }

  const sessions = await store.list(listOptions(parsed.data));
  return Response.json({ sessions });
}

async function handleSearch(
  store: SessionIndexStore,
  body: unknown
): Promise<Response> {
  const parsed = SessionIndexSearchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response("invalid search", { status: 400 });
  }

  const sessions = await store.search(
    parsed.data.query,
    searchOptions(parsed.data)
  );
  return Response.json({ sessions });
}

function readAuthorizationOptions({
  excludeKey,
  sessionScopeKey,
}: {
  readonly excludeKey?: string;
  readonly sessionScopeKey?: string;
}): SessionReadAuthorizationOptions {
  return {
    ...(excludeKey ? { excludeKey } : {}),
    ...(sessionScopeKey ? { sessionScopeKey } : {}),
  };
}

function listOptions({
  excludeKey,
  limit,
  sessionScopeKey,
}: {
  readonly excludeKey?: string;
  readonly limit?: number;
  readonly sessionScopeKey?: string;
}): SessionListOptions {
  return {
    ...(excludeKey ? { excludeKey } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(sessionScopeKey ? { sessionScopeKey } : {}),
  };
}

function searchOptions({
  excludeKey,
  limit,
  sessionScopeKey,
}: {
  readonly excludeKey?: string;
  readonly limit?: number;
  readonly sessionScopeKey?: string;
}): SessionSearchOptions {
  return {
    ...(excludeKey ? { excludeKey } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(sessionScopeKey ? { sessionScopeKey } : {}),
  };
}
