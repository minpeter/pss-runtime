import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { config } from "dotenv";

const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "https://apis.opengateway.ai/v1";
const DEFAULT_OPENAI_COMPATIBLE_MODEL_ID = "minimax/MiniMax-M2.7";

export interface OpenAICompatibleModelEnv {
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
}

export interface CreateOpenAICompatibleModelFromEnvOptions {
  env?: OpenAICompatibleModelEnv;
  providerName?: string;
}

export interface CreateOpenAICompatibleModelFromDotenvOptions {
  override?: boolean;
  providerName?: string;
  quiet?: boolean;
}

export function createOpenAICompatibleModelFromEnv({
  env = process.env,
  providerName = "custom",
}: CreateOpenAICompatibleModelFromEnvOptions = {}): LanguageModel {
  const provider = createOpenAICompatible({
    name: providerName,
    apiKey: env.AI_API_KEY?.trim() || undefined,
    baseURL: env.AI_BASE_URL?.trim() || DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  });

  return provider(env.AI_MODEL?.trim() || DEFAULT_OPENAI_COMPATIBLE_MODEL_ID);
}

export function createOpenAICompatibleModelFromDotenv({
  override = true,
  providerName = "custom",
  quiet = true,
}: CreateOpenAICompatibleModelFromDotenvOptions = {}): LanguageModel {
  config({ override, quiet });

  return createOpenAICompatibleModelFromEnv({
    env: process.env,
    providerName,
  });
}
