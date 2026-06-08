import {
  type CloudflareAlarmDrainSummary,
  type CloudflareDurableObjectNamespace,
  type CloudflareDurableObjectState,
  createCloudflareAgentContext,
  fetchCloudflareDurableObject,
} from "@minpeter/pss-runtime/cloudflare";
import { createWorkerCoordinator } from "../agent/factory";
import { jsonResponse, readTurnRequest } from "../request/http";
import {
  readWorkerRoute,
  routeWorkerRequest,
  writeWorkerRoute,
} from "../request/route";
import { appBudgets, totalHeaderBytes } from "../request/schema";
import { runStressScenario } from "../scenarios";
import type { StressScenarioResult } from "../scenarios/result";
import {
  durableAgentApiRouteResponse,
  type WorkerAgentApiEnv,
  workerAgentApiRouteResponse,
} from "./agent-api-routes";
import { alarmDrainBudget, workerStorePrefix } from "./constants";
import { publicWorkerResponse } from "./public-routes";
import { durableRunRouteResponse } from "./run-routes";

const lastResultStorageKey = "__pss_worker_last_result";

export interface Env extends WorkerAgentApiEnv {
  readonly AGENT_DURABLE_OBJECT?: CloudflareDurableObjectNamespace;
  readonly AGENT_WORKER_TOKEN?: string;
}

export class AgentDurableObject {
  readonly #env: Env;
  readonly #state: CloudflareDurableObjectState;

  constructor(state: CloudflareDurableObjectState, env: Env) {
    this.#env = env;
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const headerError = rejectLargeHeaders(request);
    if (headerError) {
      return headerError;
    }
    const url = new URL(request.url);
    const publicResponse = publicWorkerResponse(request, {
      bindingPresent: true,
    });
    if (publicResponse) {
      return publicResponse;
    }
    const apiResponse = await durableAgentApiRouteResponse({
      env: this.#env,
      lastResultStorageKey,
      request,
      storage: this.#state.storage,
    });
    if (apiResponse) {
      return apiResponse;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      const route = routeWorkerRequest(request.url, {});
      if (!route) {
        return routeError();
      }
      return jsonResponse(
        (await this.#state.storage.get<StressScenarioResult>(
          lastResultStorageKey
        )) ?? { events: [], markers: [], route, summary: null }
      );
    }
    if (request.method === "POST" && url.pathname === "/turn") {
      const body = await readTurnRequest(request);
      if (!body.ok) {
        return jsonResponse({ error: body.error }, body.status);
      }
      const route = routeWorkerRequest(request.url, body.value);
      if (!route) {
        return routeError();
      }

      await writeWorkerRoute(this.#state.storage, route);
      const result = await runStressScenario({
        env: this.#env,
        request: body.value,
        route,
        storage: this.#state.storage,
      });
      await this.#state.storage.put(lastResultStorageKey, result);
      return jsonResponse(result);
    }
    const runResponse = await durableRunRouteResponse({
      env: this.#env,
      onResult: async (result) => {
        await this.#state.storage.put(lastResultStorageKey, result);
      },
      request,
      storage: this.#state.storage,
    });
    if (runResponse) {
      return runResponse;
    }

    return jsonResponse({ error: "not found" }, 404);
  }

  async alarm(): Promise<AlarmDrainSummary> {
    const context = createCloudflareAgentContext({
      createAgent: ({ env, host, prefix, storage }) =>
        createWorkerCoordinator(storage, env, {
          host,
          prefix,
          scenario: "background-output",
        }),
      defaultPrefix: workerStorePrefix,
      env: this.#env,
      readPrefix: async ({ storage }) =>
        (await readWorkerRoute(storage))?.storePrefix,
      storage: this.#state.storage,
    });
    return await context.drainAlarm(alarmDrainBudget);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headerError = rejectLargeHeaders(request);
    if (headerError) {
      return headerError;
    }
    const publicResponse = publicWorkerResponse(request, {
      bindingPresent: Boolean(env?.AGENT_DURABLE_OBJECT),
    });
    if (publicResponse) {
      return publicResponse;
    }
    const authorizationError = authorizeProtectedRequest(request, env);
    if (authorizationError) {
      return authorizationError;
    }
    const apiResponse = await workerAgentApiRouteResponse({ env, request });
    if (apiResponse) {
      return apiResponse;
    }
    const routeResult =
      request.method === "GET"
        ? routeFromQuery(request)
        : await routeFromTurnRequest(request);
    if (!routeResult.ok) {
      return jsonResponse({ error: routeResult.error }, routeResult.status);
    }
    const route = routeResult.route;
    if (!route) {
      return routeError();
    }

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
  },
};

type AlarmDrainSummary = CloudflareAlarmDrainSummary;
type RouteReadResult =
  | { readonly ok: true; readonly route: ReturnType<typeof routeWorkerRequest> }
  | {
      readonly error: string;
      readonly ok: false;
      readonly status: 400 | 413 | 431;
    };

async function routeFromTurnRequest(
  request: Request
): Promise<RouteReadResult> {
  const body = await readTurnRequest(request.clone());
  if (!body.ok) {
    return { error: body.error, ok: false, status: body.status };
  }
  return { ok: true, route: routeWorkerRequest(request.url, body.value) };
}

function routeFromQuery(request: Request): RouteReadResult {
  return { ok: true, route: routeWorkerRequest(request.url, {}) };
}

function routeError(): Response {
  return jsonResponse(
    { error: "tenantId, userId, and conversationId are required." },
    400
  );
}

function rejectLargeHeaders(request: Request): Response | undefined {
  if (totalHeaderBytes(request.headers) <= appBudgets.maxHeaderBytes) {
    return;
  }
  return jsonResponse(
    { error: "request headers exceed the agent-worker header budget" },
    431
  );
}

function authorizeProtectedRequest(
  request: Request,
  env: Env
): Response | undefined {
  const token = env?.AGENT_WORKER_TOKEN?.trim();
  if (!token) {
    return jsonResponse(
      {
        error:
          "AGENT_WORKER_TOKEN is required for agent-worker /turn, /runs, and /events routes.",
      },
      500
    );
  }
  if (request.headers.get("authorization") === `Bearer ${token}`) {
    return;
  }
  return jsonResponse({ error: "unauthorized" }, 401);
}
