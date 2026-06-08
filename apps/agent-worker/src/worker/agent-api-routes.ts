import {
  type CloudflareDurableObjectNamespace,
  type CloudflareDurableObjectStorage,
  fetchCloudflareDurableObject,
} from "@minpeter/pss-runtime/cloudflare";
import {
  readAgentApiRoute,
  readAgentTurnRequest,
  readSandboxFileEditRequest,
} from "../request/agent-api";
import { jsonResponse } from "../request/http";
import { type WorkerRoute, writeWorkerRoute } from "../request/route";
import {
  runSandboxFileEditDemo,
  type SandboxSdkEnv,
} from "../sandbox/file-edit";
import { runStressScenario } from "../scenarios";
import type { StressScenarioResult } from "../scenarios/result";

export interface WorkerAgentApiEnv extends SandboxSdkEnv {
  readonly AGENT_DURABLE_OBJECT?: CloudflareDurableObjectNamespace;
}

export interface DurableAgentApiRouteOptions {
  readonly env: unknown;
  readonly lastResultStorageKey: string;
  readonly request: Request;
  readonly storage: CloudflareDurableObjectStorage;
}

export interface WorkerAgentApiRouteOptions {
  readonly env: WorkerAgentApiEnv;
  readonly request: Request;
}

export async function durableAgentApiRouteResponse(
  options: DurableAgentApiRouteOptions
): Promise<Response | undefined> {
  const route = readAgentApiRoute(options.request.url);
  if (!route) {
    return;
  }
  switch (route.kind) {
    case "events":
      if (options.request.method !== "GET") {
        return methodNotAllowed();
      }
      return await readEvents(
        options.storage,
        options.lastResultStorageKey,
        route.workerRoute
      );
    case "turn":
      if (options.request.method !== "POST") {
        return methodNotAllowed();
      }
      return await runTurn(options, route.workerRoute);
    case "sandbox-file-edit":
      return jsonResponse({ error: "not found" }, 404);
    default:
      return assertNever(route);
  }
}

export async function workerAgentApiRouteResponse(
  options: WorkerAgentApiRouteOptions
): Promise<Response | undefined> {
  const route = readAgentApiRoute(options.request.url);
  if (!route) {
    return;
  }
  switch (route.kind) {
    case "events":
    case "turn":
      if (!methodMatchesApiRoute(options.request.method, route.kind)) {
        return methodNotAllowed();
      }
      return await fetchDurableRoute(
        options.request,
        options.env,
        route.workerRoute
      );
    case "sandbox-file-edit":
      if (options.request.method !== "POST") {
        return methodNotAllowed();
      }
      return await runSandboxRoute(options, route.sandboxRoute);
    default:
      return assertNever(route);
  }
}

async function runTurn(
  options: DurableAgentApiRouteOptions,
  route: WorkerRoute
): Promise<Response> {
  const body = await readAgentTurnRequest(options.request, route);
  if (!body.ok) {
    return jsonResponse({ error: body.error }, body.status);
  }

  await writeWorkerRoute(options.storage, route);
  const result = await runStressScenario({
    env: options.env,
    request: body.value,
    route,
    storage: options.storage,
  });
  await options.storage.put(options.lastResultStorageKey, result);
  return jsonResponse(result);
}

async function readEvents(
  storage: CloudflareDurableObjectStorage,
  lastResultStorageKey: string,
  route: WorkerRoute
): Promise<Response> {
  return jsonResponse(
    (await storage.get<StressScenarioResult>(lastResultStorageKey)) ?? {
      events: [],
      markers: [],
      route,
      summary: null,
    }
  );
}

async function fetchDurableRoute(
  request: Request,
  env: WorkerAgentApiEnv,
  route: WorkerRoute
): Promise<Response> {
  const response = await fetchCloudflareDurableObject({
    namespace: env?.AGENT_DURABLE_OBJECT,
    objectName: route.objectName,
    request,
  });
  if (response) {
    return response;
  }

  return jsonResponse(
    {
      error:
        "AGENT_DURABLE_OBJECT binding is required outside the local simulation.",
    },
    500
  );
}

async function runSandboxRoute(
  options: WorkerAgentApiRouteOptions,
  route: Extract<
    NonNullable<ReturnType<typeof readAgentApiRoute>>,
    { readonly kind: "sandbox-file-edit" }
  >["sandboxRoute"]
): Promise<Response> {
  const body = await readSandboxFileEditRequest(options.request);
  if (!body.ok) {
    return jsonResponse({ error: body.error }, body.status);
  }
  return jsonResponse(
    await runSandboxFileEditDemo({
      env: options.env,
      fileEdit: body.value,
      route,
    })
  );
}

function methodMatchesApiRoute(
  method: string,
  kind: "events" | "turn"
): boolean {
  switch (kind) {
    case "events":
      return method === "GET";
    case "turn":
      return method === "POST";
    default:
      return assertNever(kind);
  }
}

function methodNotAllowed(): Response {
  return jsonResponse({ error: "method not allowed" }, 405);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled agent API route: ${String(value)}`);
}
