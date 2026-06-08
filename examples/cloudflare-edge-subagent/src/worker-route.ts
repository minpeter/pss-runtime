import type { CloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import { workerStorePrefix } from "./worker-constants";

const workerRouteStorageKey = "__pss_worker_route";

export interface WorkerRoute {
  readonly conversationId: string;
  readonly objectName: string;
  readonly sessionKey: string;
  readonly storePrefix: string;
  readonly tenantId: string;
  readonly userId: string;
}

export function routeWorkerRequest(
  requestUrl: string,
  body: unknown
): WorkerRoute | undefined {
  const url = new URL(requestUrl);
  const tenantId = readRouteValue(body, url, "tenantId", "tenant");
  const userId = readRouteValue(body, url, "userId", "user");
  const conversationId = readRouteValue(
    body,
    url,
    "conversationId",
    "conversation"
  );
  if (!(tenantId && userId && conversationId)) {
    return;
  }

  return {
    conversationId,
    objectName: objectNameFromRoute({ conversationId, tenantId, userId }),
    sessionKey: sessionKeyFromRoute({ conversationId, tenantId, userId }),
    storePrefix: storePrefixFromRoute({ conversationId, tenantId, userId }),
    tenantId,
    userId,
  };
}

export function sessionKeyFromRoute(route: {
  readonly conversationId: string;
  readonly tenantId: string;
  readonly userId: string;
}): string {
  return [
    "tenant",
    routeToken(route.tenantId),
    "conversation",
    routeToken(route.conversationId),
    "user",
    routeToken(route.userId),
  ].join(":");
}

export async function writeWorkerRoute(
  storage: CloudflareDurableObjectStorage,
  route: WorkerRoute
): Promise<void> {
  await storage.put(workerRouteStorageKey, route);
}

export async function readWorkerRoute(
  storage: CloudflareDurableObjectStorage
): Promise<WorkerRoute | undefined> {
  return await storage.get<WorkerRoute>(workerRouteStorageKey);
}

function objectNameFromRoute(route: {
  readonly conversationId: string;
  readonly tenantId: string;
  readonly userId: string;
}): string {
  return [
    "support-agent",
    routeToken(route.tenantId),
    routeToken(route.conversationId),
    routeToken(route.userId),
  ].join(":");
}

function storePrefixFromRoute(route: {
  readonly conversationId: string;
  readonly tenantId: string;
  readonly userId: string;
}): string {
  return [
    workerStorePrefix,
    "tenant",
    routeToken(route.tenantId),
    "conversation",
    routeToken(route.conversationId),
    "user",
    routeToken(route.userId),
  ].join(":");
}

function readRouteValue(
  body: unknown,
  url: URL,
  bodyKey: string,
  queryKey: string
): string | undefined {
  const bodyValue = readBodyStringField(body, bodyKey);
  const value = bodyValue ?? url.searchParams.get(queryKey) ?? undefined;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readBodyStringField(body: unknown, key: string): string | undefined {
  if (!isRecord(body)) {
    return;
  }

  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function routeToken(value: string): string {
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
