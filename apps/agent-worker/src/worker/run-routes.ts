import type { CloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import { jsonResponse, readTurnRequest } from "../request/http";
import { routeWorkerRequest, writeWorkerRoute } from "../request/route";
import { readRun, readRunEvents, recordCompletedRun } from "../runs/store";
import { runStressScenario } from "../scenarios";
import type { StressScenarioResult } from "../scenarios/result";

export interface DurableRunRouteOptions {
  readonly env: unknown;
  readonly onResult?: (result: StressScenarioResult) => Promise<void>;
  readonly request: Request;
  readonly storage: CloudflareDurableObjectStorage;
}

export async function durableRunRouteResponse(
  options: DurableRunRouteOptions
): Promise<Response | undefined> {
  const url = new URL(options.request.url);
  if (options.request.method === "POST" && url.pathname === "/runs") {
    return await createRun(options);
  }
  if (options.request.method !== "GET") {
    return;
  }

  const runPath = parseRunPath(url.pathname);
  if (!runPath) {
    return;
  }
  const route = routeWorkerRequest(options.request.url, {});
  if (!route) {
    return routeError();
  }
  const payload =
    runPath.kind === "events"
      ? await readRunEvents(options.storage, runPath.runId)
      : await readRun(options.storage, runPath.runId);
  return payload
    ? jsonResponse(payload)
    : jsonResponse({ error: "run not found" }, 404);
}

async function createRun(options: DurableRunRouteOptions): Promise<Response> {
  const body = await readTurnRequest(options.request);
  if (!body.ok) {
    return jsonResponse({ error: body.error }, body.status);
  }
  const route = routeWorkerRequest(options.request.url, body.value);
  if (!route) {
    return routeError();
  }
  await writeWorkerRoute(options.storage, route);
  const result = await runStressScenario({
    env: options.env,
    request: body.value,
    route,
    storage: options.storage,
  });
  if (options.onResult) {
    await options.onResult(result);
  }
  return jsonResponse(
    await recordCompletedRun(options.storage, route, result),
    201
  );
}

type RunPath =
  | { readonly kind: "events"; readonly runId: string }
  | { readonly kind: "run"; readonly runId: string };

function parseRunPath(pathname: string): RunPath | undefined {
  const segments = pathname.split("/").filter(Boolean);
  const [resource, runId, detail, extra] = segments;
  if (resource !== "runs" || !runId || extra) {
    return;
  }
  if (!detail) {
    return { kind: "run", runId };
  }
  return detail === "events" ? { kind: "events", runId } : undefined;
}

function routeError(): Response {
  return jsonResponse(
    { error: "tenantId, userId, and conversationId are required." },
    400
  );
}
