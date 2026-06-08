import { Agent } from "@minpeter/pss-runtime";
import {
  type CloudflareAlarmDrainSummary,
  drainAgentRun,
  drainCloudflareAlarm,
} from "./cloudflare-alarm-drainer";
import {
  type CloudflareDurableObjectStorage,
  createCloudflareDurableObjectHost,
} from "./cloudflare-host";
import { workerStorePrefix } from "./worker-constants";
import {
  createWorkerCoordinatorModel,
  workerResearcherModel,
} from "./worker-model";
import {
  readWorkerRoute,
  routeWorkerRequest,
  writeWorkerRoute,
} from "./worker-route";

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
    if (request.method === "POST" && url.pathname === "/turn") {
      const body = await readJsonBody(request);
      const route = routeWorkerRequest(request.url, body);
      if (!route) {
        return jsonResponse(
          {
            error:
              "tenantId, userId, and conversationId are required for /turn.",
          },
          400
        );
      }

      await writeWorkerRoute(this.#state.storage, route);
      const input = readTextInput(body);
      const events = await drainAgentRun(
        await this.#agent(route.storePrefix)
          .session(route.sessionKey)
          .send(input)
      );
      return jsonResponse({
        events,
        markers: ["request-boundary:launch"],
      });
    }

    return jsonResponse({ error: "not found" }, 404);
  }

  async alarm(): Promise<AlarmDrainSummary> {
    const route = await readWorkerRoute(this.#state.storage);
    return await drainCloudflareAlarm({
      agent: this.#agent(route?.storePrefix ?? workerStorePrefix),
      prefix: route?.storePrefix ?? workerStorePrefix,
      storage: this.#state.storage,
    });
  }

  #agent(prefix = workerStorePrefix): Agent {
    return createWorkerCoordinator(this.#state.storage, this.#env, { prefix });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const route = routeWorkerRequest(
      request.url,
      await readJsonBody(request.clone())
    );
    if (!route) {
      return jsonResponse(
        { error: "tenantId, userId, and conversationId are required." },
        400
      );
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

export function createWorkerCoordinator(
  storage: CloudflareDurableObjectStorage,
  _env: Env = {},
  options: { readonly prefix?: string } = {}
): Agent {
  const host = createCloudflareDurableObjectHost({
    prefix: options.prefix ?? workerStorePrefix,
    storage,
  });
  const researcher = new Agent({
    description: "Produces compact research notes for the coordinator.",
    host,
    model: workerResearcherModel,
    name: "researcher",
    namespace: "cloudflare-worker-researcher",
  });

  return new Agent({
    host,
    instructions: [
      "Coordinate background research in a Worker Durable Object.",
      "When asked for background research, call delegate_to_researcher once with run_in_background: true.",
      "Do not call background_output until a <system-reminder> says the background task completed.",
      "After the reminder, call background_output with block: true and return a concise final answer.",
    ].join(" "),
    model: createWorkerCoordinatorModel(),
    namespace: "cloudflare-worker-coordinator",
    subagents: [researcher],
  });
}

type AlarmDrainSummary = CloudflareAlarmDrainSummary;

async function readJsonBody(request: {
  json(): Promise<unknown>;
}): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function readTextInput(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "input" in body &&
    typeof body.input === "string"
  ) {
    return body.input;
  }

  return "Start background research on edge-hosted task ids.";
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
