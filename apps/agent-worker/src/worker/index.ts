import {
  type CloudflareAlarmDrainSummary,
  type CloudflareDurableObjectState,
  createCloudflareAgentContext,
} from "@minpeter/pss-runtime/cloudflare";
import { createAgentWorkerAlarmAgent } from "../agent/alarm-agent";
import { parseAgentWorkerBindings } from "../agent/config";
import { createChatAgent, createExecutionAgent } from "../agent/factory";
import { deliverAlarmAssistantText } from "../telegram/alarm-delivery";
import { readTelegramRoute } from "../telegram/route-store";
import { jsonResponse } from "./http";
import {
  durableTelegramRouteResponse,
  type WorkerTelegramEnv,
  workerTelegramRouteResponse,
} from "./telegram-routes";

export interface Env extends WorkerTelegramEnv {}

export class AgentDurableObject {
  readonly #bindings: Env;
  readonly #state: CloudflareDurableObjectState;

  constructor(state: CloudflareDurableObjectState, bindings: Env) {
    this.#bindings = bindings;
    this.#state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const telegramResponse = await durableTelegramRouteResponse({
      bindings: parseAgentWorkerBindings(this.#bindings),
      request,
      storage: this.#state.storage,
      waitUntil: (task) => this.#state.waitUntil(task),
    });
    if (telegramResponse) {
      return telegramResponse;
    }
    return jsonResponse({ error: "not found" }, 404);
  }

  async alarm(): Promise<CloudflareAlarmDrainSummary> {
    const summary = await this.#context().drainAlarm();
    const route = await readTelegramRoute(this.#state.storage);
    if (route) {
      await deliverAlarmAssistantText({
        bindings: parseAgentWorkerBindings(this.#bindings),
        route,
        summary,
      });
    }
    return summary;
  }

  #context() {
    return createCloudflareAgentContext({
      createAgent: ({ host, prefix }) => {
        const bindings = parseAgentWorkerBindings(this.#bindings);
        const chatAgent = createChatAgent(
          this.#state.storage,
          prefix,
          bindings,
          { host }
        );
        const executionAgent = createExecutionAgent(host, bindings);
        return createAgentWorkerAlarmAgent({ chatAgent, executionAgent });
      },
      defaultPrefix: "telegram-chat",
      env: this.#bindings,
      readPrefix: async ({ storage }) =>
        (await readTelegramRoute(storage))?.storePrefix,
      storage: this.#state.storage,
    });
  }
}

export default {
  async fetch(request: Request, bindings: Env): Promise<Response> {
    const telegramResponse = await workerTelegramRouteResponse({
      bindings,
      request,
    });
    if (telegramResponse) {
      return telegramResponse;
    }
    return jsonResponse({ error: "not found" }, 404);
  },
};
