import type { Agent } from "@minpeter/pss-runtime";
import {
  type CloudflareAgentContext,
  createCloudflareAgentContext,
} from "@minpeter/pss-runtime/cloudflare";

import { collectAssistantText, createConfiguredAgent } from "./agent";
import type { Env } from "./env";

const SESSION_KEY = "default";

interface AgentRequestPayload {
  readonly text: string;
}

export class AgentDurableObject {
  readonly #context: CloudflareAgentContext<Agent>;

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

    const payload = await parseAgentRequest(request);
    if (!payload) {
      return new Response("text required", { status: 400 });
    }

    const agent = this.#context.agent();
    const run = await agent.session(SESSION_KEY).send(payload.text);
    const reply = await collectAssistantText(run);

    return Response.json({ reply: reply || "(no response)" });
  }

  async alarm(): Promise<void> {
    await this.#context.drainAlarm();
  }
}

export async function parseAgentRequest(
  request: Request
): Promise<AgentRequestPayload | undefined> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch (error) {
    if (error instanceof Error) {
      return;
    }
    throw error;
  }

  if (
    typeof payload !== "object" ||
    payload === null ||
    !("text" in payload) ||
    typeof payload.text !== "string"
  ) {
    return;
  }

  const text = payload.text.trim();
  return text ? { text } : undefined;
}
