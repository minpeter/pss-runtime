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
import {
  createWorkerCoordinatorModel,
  workerResearcherModel,
} from "./worker-model";

const defaultSessionKey = "room:demo:user:edge";
export const workerStorePrefix = "cloudflare-edge-subagent-demo";

export interface Env {
  readonly AGENT_DURABLE_OBJECT?: AgentDurableObjectNamespace;
}

interface AgentDurableObjectNamespace {
  get(id: AgentDurableObjectId): AgentDurableObjectStub;
  idFromName(name: string): AgentDurableObjectId;
}

type AgentDurableObjectId = unknown;

interface AgentDurableObjectStub {
  fetch(request: Request): Promise<Response>;
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
      const input = readTextInput(body);
      const events = await drainAgentRun(
        await this.#agent().session(defaultSessionKey).send(input)
      );
      return jsonResponse({
        events,
        markers: ["request-boundary:launch"],
      });
    }

    if (request.method === "POST" && url.pathname === "/alarm") {
      const summary = await this.alarm();
      return jsonResponse(summary);
    }

    return jsonResponse({ error: "not found" }, 404);
  }

  async alarm(): Promise<AlarmDrainSummary> {
    return await drainCloudflareAlarm({
      agent: this.#agent(),
      prefix: workerStorePrefix,
      storage: this.#state.storage,
    });
  }

  #agent(): Agent {
    return createWorkerCoordinator(this.#state.storage, this.#env);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.AGENT_DURABLE_OBJECT?.idFromName("default");
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
  _env: Env = {}
): Agent {
  const host = createCloudflareDurableObjectHost({
    prefix: workerStorePrefix,
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

async function readJsonBody(request: Request): Promise<unknown> {
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
