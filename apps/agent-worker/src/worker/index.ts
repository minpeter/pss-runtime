import type { CloudflareDurableObjectState } from "@minpeter/pss-runtime/cloudflare";
import { parseAgentWorkerBindings } from "../agent/config";
import {
  durableTelegramRouteResponse,
  type WorkerTelegramEnv,
  workerTelegramRouteResponse,
} from "./telegram-routes";
import { jsonResponse } from "./http";

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