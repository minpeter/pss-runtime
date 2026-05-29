import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  type AgentToolChoice,
  createLookAtLlm,
  type RuntimeLlm,
} from "@minpeter/pss-runtime";
import type { LanguageModel, ToolSet } from "ai";
import { config } from "dotenv";
import {
  type CodingAgentRuntimeEnv,
  readLookAtModelEnv,
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

export interface CreateLookAtLlmFromEnvOptions {
  instructions?: string;
  model: LanguageModel;
  providerName?: string;
  runtimeEnv?: CodingAgentRuntimeEnv;
  toolChoice?: AgentToolChoice;
  tools?: ToolSet;
}

export function createOpenAICompatibleModelFromEnv({
  providerName = "custom",
  runtimeEnv = process.env,
}: CreateOpenAICompatibleModelFromEnvOptions = {}): LanguageModel {
  const env = readOpenAICompatibleModelEnv({ runtimeEnv });
  const provider = createOpenAICompatible({
    name: providerName,
    apiKey: env.AI_API_KEY,
    baseURL: env.AI_BASE_URL,
  });

  return provider(env.AI_MODEL);
}

export function createLookAtVisionModelFromEnv({
  providerName = "look_at",
  runtimeEnv = process.env,
}: CreateOpenAICompatibleModelFromEnvOptions = {}): LanguageModel | undefined {
  const env = readLookAtModelEnv({ runtimeEnv });

  if (!env.enabled) {
    return;
  }

  const provider = createOpenAICompatible({
    name: providerName,
    apiKey: env.apiKey,
    baseURL: env.baseUrl,
  });

  return provider(env.model);
}

export function createLookAtLlmFromEnv({
  instructions,
  model,
  providerName,
  runtimeEnv = process.env,
  toolChoice,
  tools,
}: CreateLookAtLlmFromEnvOptions): RuntimeLlm | undefined {
  const env = readLookAtModelEnv({ runtimeEnv });

  if (!env.enabled) {
    return;
  }

  const visionModel = createLookAtVisionModelFromEnv({
    providerName,
    runtimeEnv,
  });

  if (visionModel === undefined) {
    throw new Error("look_at vision model configuration is disabled.");
  }

  return createLookAtLlm({
    instructions,
    maxImageBytes: env.maxImageBytes,
    maxOutputChars: env.maxOutputChars,
    model,
    toolChoice,
    tools,
    visionModel,
  });
}

export function createCodingLanguageModel({
  override = true,
  providerName = "custom",
  quiet = true,
}: CreateOpenAICompatibleModelFromDotenvOptions = {}): LanguageModel {
  config({ override, quiet });

  return createOpenAICompatibleModelFromEnv({
    providerName,
  });
}
