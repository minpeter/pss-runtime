import { Agent, type AgentHost } from "@minpeter/pss-runtime";
import {
  type CloudflareAlarmDrainSummary,
  type CloudflareDurableObjectNamespace,
  type CloudflareDurableObjectState,
  type CloudflareDurableObjectStorage,
  createCloudflareAgentContext,
  createCloudflareDurableObjectHost,
  drainAgentRun,
  fetchCloudflareDurableObject,
} from "@minpeter/pss-runtime/cloudflare";
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
  readonly AGENT_DURABLE_OBJECT?: CloudflareDurableObjectNamespace;
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
        await this.#context()
          .agent(route.storePrefix)
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
    return await this.#context().drainAlarm();
  }

  #context() {
    return createCloudflareAgentContext({
      createAgent: ({ env, host, prefix, storage }) =>
        createWorkerCoordinator(storage, env, { host, prefix }),
      defaultPrefix: workerStorePrefix,
      env: this.#env,
      readPrefix: async ({ storage }) =>
        (await readWorkerRoute(storage))?.storePrefix,
      storage: this.#state.storage,
    });
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

    const response = await fetchCloudflareDurableObject({
      namespace: env.AGENT_DURABLE_OBJECT,
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

export function createWorkerCoordinator(
  storage: CloudflareDurableObjectStorage,
  _env: Env = {},
  options: { readonly host?: AgentHost; readonly prefix?: string } = {}
): Agent {
  const host =
    options.host ??
    createCloudflareDurableObjectHost({
      prefix: options.prefix ?? workerStorePrefix,
      storage,
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
    subagents: [
      {
        description: "Produces compact research notes for the coordinator.",
        agent: new Agent({
          host,
          model: workerResearcherModel,
          namespace: "cloudflare-worker-researcher",
        }),
        name: "researcher",
      },
    ],
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
