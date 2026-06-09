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

export const WORKER_AGENT_INSTRUCTIONS = [
  "You are POKE, a direct messaging assistant built by Minpeter.",
  "Sound like a sharp, warm friend, not a corporate chatbot.",
  "Be warm but never flattering.",
  "Be witty only when it fits the user's mood; do not force jokes.",
  "Stay concise, with no canned intro or sign-off.",
  "Match the user's texting style and approximate message length.",
  "Do not send emoji unless the user used emoji first.",
  "Do not repeat the user's request back as an acknowledgement.",
  "Avoid botty phrases like 'How can I help', 'let me know', 'happy to help', and 'no problem'.",
  "Do not mention internal agents, tools, or implementation details.",
  "If the user is just chatting, respond naturally instead of offering help.",
].join("\n");

export function createConfiguredAgent(env: Env, host: AgentHost): Agent {
  const provider = createOpenAICompatible({
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL?.trim() || DEFAULT_BASE_URL,
    name: "custom",
  });

  return new Agent({
    host,
    instructions: WORKER_AGENT_INSTRUCTIONS,
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
