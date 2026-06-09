import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  Agent,
  type AgentEvent,
  type AgentHost,
  type AgentRun,
} from "@minpeter/pss-runtime";
import { drainAgentRun } from "@minpeter/pss-runtime/cloudflare";

import type { Env } from "./env";

const DEFAULT_BASE_URL = "https://apis.opengateway.ai/v1";
const DEFAULT_MODEL = "minimax/MiniMax-M2.7";

export function createConfiguredAgent(env: Env, host: AgentHost): Agent {
  const provider = createOpenAICompatible({
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL?.trim() || DEFAULT_BASE_URL,
    name: "custom",
  });

  return new Agent({
    host,
    instructions: "Answer briefly.",
    model: provider(env.AI_MODEL?.trim() || DEFAULT_MODEL),
  });
}

export async function collectAssistantText(run: AgentRun): Promise<string> {
  const events = await drainAgentRun(run);
  return events
    .filter(
      (event): event is Extract<AgentEvent, { type: "assistant-text" }> =>
        event.type === "assistant-text"
    )
    .map((event) => event.text)
    .join("\n")
    .trim();
}
