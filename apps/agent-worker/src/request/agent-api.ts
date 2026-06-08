import { z } from "zod";
import {
  type JsonRequestReadResult,
  readJsonRequest,
  type TurnRequestReadResult,
} from "./http";
import { createWorkerRoute, type WorkerRoute } from "./route";
import { appBudgets, parseTurnBody } from "./schema";

export type AgentApiRoute =
  | { readonly kind: "events"; readonly workerRoute: WorkerRoute }
  | {
      readonly kind: "sandbox-file-edit";
      readonly sandboxRoute: SandboxUserRoute;
    }
  | { readonly kind: "turn"; readonly workerRoute: WorkerRoute };

export interface SandboxFileEditRequest {
  readonly content: string;
  readonly filename: string;
  readonly path: string;
}

export interface SandboxUserRoute {
  readonly sandboxName: string;
  readonly tenantId: string;
  readonly userId: string;
}

export type SandboxFileEditReadResult =
  | {
      readonly ok: true;
      readonly status: 200;
      readonly value: SandboxFileEditRequest;
    }
  | {
      readonly error: string;
      readonly ok: false;
      readonly status: 400 | 413 | 431;
    };

const sandboxFileEditSchema = z
  .object({
    content: z.string().min(1).max(appBudgets.maxSandboxFileBytes),
    filename: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._-]+\.py$/)
      .max(120)
      .optional(),
  })
  .strict();

export function readAgentApiRoute(
  requestUrl: string
): AgentApiRoute | undefined {
  return readVersionedRoute(requestUrl) ?? readAgentsSdkRoute(requestUrl);
}

function readVersionedRoute(requestUrl: string): AgentApiRoute | undefined {
  const parts = new URL(requestUrl).pathname.split("/").filter(Boolean);
  const tenantId = readPathToken(parts, 2);
  const userId = readPathToken(parts, 4);
  if (
    parts[0] !== "v1" ||
    parts[1] !== "tenants" ||
    parts[3] !== "users" ||
    !(tenantId && userId)
  ) {
    return;
  }

  if (
    parts[5] === "sandbox" &&
    parts[6] === "file-edit" &&
    parts.length === 7
  ) {
    return {
      kind: "sandbox-file-edit",
      sandboxRoute: createSandboxUserRoute({ tenantId, userId }),
    };
  }

  const conversationId = readPathToken(parts, 6);
  if (parts[5] !== "conversations" || !conversationId || parts.length !== 8) {
    return;
  }

  const workerRoute = createWorkerRoute({ conversationId, tenantId, userId });
  switch (parts[7]) {
    case "events":
      return { kind: "events", workerRoute };
    case "turn":
      return { kind: "turn", workerRoute };
    default:
      return;
  }
}

function readAgentsSdkRoute(requestUrl: string): AgentApiRoute | undefined {
  const url = new URL(requestUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const userId = readPathToken(parts, 2);
  const tenantId = readQueryToken(url, "tenant");
  if (
    parts[0] !== "agents" ||
    parts[1] !== "pss-agent-worker" ||
    !(tenantId && userId)
  ) {
    return;
  }

  if (
    parts[3] === "sandbox" &&
    parts[4] === "file-edit" &&
    parts.length === 5
  ) {
    return {
      kind: "sandbox-file-edit",
      sandboxRoute: createSandboxUserRoute({ tenantId, userId }),
    };
  }

  const conversationId = readQueryToken(url, "conversation");
  if (!conversationId || parts.length !== 4) {
    return;
  }

  const workerRoute = createWorkerRoute({ conversationId, tenantId, userId });
  switch (parts[3]) {
    case "events":
      return { kind: "events", workerRoute };
    case "turn":
      return { kind: "turn", workerRoute };
    default:
      return;
  }
}

export async function readAgentTurnRequest(
  request: Parameters<typeof readJsonRequest>[0],
  workerRoute: WorkerRoute
): Promise<TurnRequestReadResult> {
  const parsedJson = await readJsonRequest(request);
  if (!parsedJson.ok) {
    return parsedJson;
  }

  return parseTurnBody(withRouteIdentity(parsedJson.value, workerRoute));
}

export async function readSandboxFileEditRequest(
  request: Parameters<typeof readJsonRequest>[0]
): Promise<SandboxFileEditReadResult> {
  const parsedJson = await readJsonRequest(request);
  if (!parsedJson.ok) {
    return parsedJson;
  }

  return parseSandboxFileEditBody(parsedJson);
}

function parseSandboxFileEditBody(
  parsedJson: Extract<JsonRequestReadResult, { readonly ok: true }>
): SandboxFileEditReadResult {
  const parsed = sandboxFileEditSchema.safeParse(parsedJson.value);
  if (!parsed.success) {
    return {
      error: parsed.error.issues.map((issue) => issue.message).join("; "),
      ok: false,
      status: 400,
    };
  }

  const filename = parsed.data.filename ?? "hello.py";
  return {
    ok: true,
    status: 200,
    value: {
      content: parsed.data.content,
      filename,
      path: `/workspace/${filename}`,
    },
  };
}

function withRouteIdentity(value: unknown, route: WorkerRoute): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return {
    ...value,
    conversationId: route.conversationId,
    tenantId: route.tenantId,
    userId: route.userId,
  };
}

function createSandboxUserRoute(route: {
  readonly tenantId: string;
  readonly userId: string;
}): SandboxUserRoute {
  return {
    sandboxName: `tenant-${encodeURIComponent(route.tenantId)}-user-${encodeURIComponent(route.userId)}`,
    tenantId: route.tenantId,
    userId: route.userId,
  };
}

function readQueryToken(url: URL, key: string): string | undefined {
  const raw = url.searchParams.get(key);
  if (!raw) {
    return;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > appBudgets.maxRouteTokenChars) {
    return;
  }
  return trimmed;
}

function readPathToken(
  parts: readonly string[],
  index: number
): string | undefined {
  const raw = parts[index];
  if (!raw) {
    return;
  }
  const decoded = decodePathToken(raw);
  const trimmed = decoded?.trim();
  if (!trimmed || trimmed.length > appBudgets.maxRouteTokenChars) {
    return;
  }
  return trimmed;
}

function decodePathToken(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) {
      return;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
