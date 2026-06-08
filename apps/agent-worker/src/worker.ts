import { createWorkerCoordinator } from "./agent-factory";
import {
  type CloudflareAlarmDrainSummary,
  drainCloudflareAlarm,
} from "./cloudflare-alarm-drainer";
import type { CloudflareDurableObjectStorage } from "./cloudflare-host";
import { jsonResponse, readTurnRequest } from "./http";
import type { StressScenarioResult } from "./stress-result";
import { createHealthPayload, runStressScenario } from "./stress-scenarios";
import { workerStorePrefix } from "./worker-constants";
import {
  readWorkerRoute,
  routeWorkerRequest,
  writeWorkerRoute,
} from "./worker-route";

const lastResultStorageKey = "__pss_worker_last_result";

export interface Env {
  readonly AGENT_DURABLE_OBJECT?: AgentDurableObjectNamespace;
}

interface AgentDurableObjectNamespace {
  get(id: AgentDurableObjectId): AgentDurableObjectStub;
  idFromName(name: string): AgentDurableObjectId;
}

type AgentDurableObjectId = unknown;

interface AgentDurableObjectStub {
  fetch(request: unknown): Promise<Response>;
}

export interface CloudflareDurableObjectState {
  readonly storage: CloudflareDurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}

export class AgentDurableObject {
  readonly #env: Env;
  readonly #state: CloudflareDurableObjectState;

  constructor(state: CloudflareDurableObjectState, env: Env) {
    this.#env = env;
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(createHealthPayload({ bindingPresent: true }));
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

    return jsonResponse({ error: "not found" }, 404);
  }

  async alarm(): Promise<AlarmDrainSummary> {
    const route = await readWorkerRoute(this.#state.storage);
    return await drainCloudflareAlarm({
      agent: createWorkerCoordinator(this.#state.storage, this.#env, {
        prefix: route?.storePrefix ?? workerStorePrefix,
        scenario: "background-output",
      }),
      prefix: route?.storePrefix ?? workerStorePrefix,
      storage: this.#state.storage,
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(
        createHealthPayload({
          bindingPresent: Boolean(env.AGENT_DURABLE_OBJECT),
        })
      );
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

    const id = env.AGENT_DURABLE_OBJECT?.idFromName(route.objectName);
    const stub = id ? env.AGENT_DURABLE_OBJECT?.get(id) : undefined;
    if (stub) {
      return await stub.fetch(request);
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
