import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { z } from "zod";

const defaultBaseUrl = "https://apis.opengateway.ai/v1";
const defaultModel = "minimax/MiniMax-M2.7";

const bindingsSchema = z.object({
  AI_API_KEY: z.string().trim().min(1),
  AI_BASE_URL: z.url().trim().optional(),
  AI_MODEL: z.string().trim().min(1).optional(),
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1).optional(),
});

export interface AgentWorkerBindings {
  readonly AI_API_KEY: string;
  readonly AI_BASE_URL?: string;
  readonly AI_MODEL?: string;
  readonly TELEGRAM_BOT_TOKEN?: string;
}

export function parseAgentWorkerBindings(
  value: unknown
): AgentWorkerBindings {
  const parsed = bindingsSchema.parse(value);
  return {
    AI_API_KEY: parsed.AI_API_KEY,
    AI_BASE_URL: parsed.AI_BASE_URL ?? defaultBaseUrl,
    AI_MODEL: parsed.AI_MODEL ?? defaultModel,
    TELEGRAM_BOT_TOKEN: parsed.TELEGRAM_BOT_TOKEN,
  };
}

export function createLanguageModel(
  bindings: AgentWorkerBindings
): LanguageModel {
  const provider = createOpenAICompatible({
    name: "custom",
    apiKey: bindings.AI_API_KEY,
    baseURL: bindings.AI_BASE_URL ?? defaultBaseUrl,
  });
  return provider(bindings.AI_MODEL ?? defaultModel);
}