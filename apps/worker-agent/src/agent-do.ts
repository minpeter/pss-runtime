import { createCloudflareAgentContext } from "@minpeter/pss-runtime/cloudflare";

import { collectAssistantText, createConfiguredAgent } from "./agent";
import type { Env } from "./env";

const SESSION_KEY = "default";

export class AgentDurableObject {
  readonly #context;

  constructor(state: DurableObjectState, env: Env) {
    this.#context = createCloudflareAgentContext({
      createAgent: ({ env: agentEnv, host }) =>
        createConfiguredAgent(agentEnv, host),
      env,
      storage: state.storage,
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const payload = (await request.json()) as { readonly text?: string };
    const text = payload.text?.trim();
    if (!text) {
      return new Response("text required", { status: 400 });
    }

    const agent = this.#context.agent();
    const run = await agent.session(SESSION_KEY).send(text);
    const reply = await collectAssistantText(run);

    return Response.json({ reply: reply || "(no response)" });
  }

  async alarm(): Promise<void> {
    await this.#context.drainAlarm();
  }
}
