import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AgentModel } from "@minpeter/pss-runtime";
import { config } from "dotenv";
import {
  type CodingAgentRuntimeEnv,
  readOpenAICompatibleModelEnv,
} from "./env";

export interface CreateOpenAICompatibleModelFromEnvOptions {
  providerName?: string;
  runtimeEnv?: CodingAgentRuntimeEnv;
}

export interface CreateOpenAICompatibleModelFromDotenvOptions {
  override?: boolean;
  providerName?: string;
  quiet?: boolean;
}

export function createOpenAICompatibleModelFromEnv({
  providerName = "custom",
  runtimeEnv = process.env,
}: CreateOpenAICompatibleModelFromEnvOptions = {}): AgentModel {
  const env = readOpenAICompatibleModelEnv({ runtimeEnv });
  const provider = createOpenAICompatible({
    name: providerName,
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL,
  });

  return provider(env.AI_MODEL);
}

export function createCodingAgentModel({
  override = true,
  providerName = "custom",
  quiet = true,
}: CreateOpenAICompatibleModelFromDotenvOptions = {}): AgentModel {
  config({ override, quiet });

  return createOpenAICompatibleModelFromEnv({
    providerName,
  });
}
