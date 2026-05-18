import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { AgentTools } from "../tools";
import { env } from "./env";

export type LlmOutput = Awaited<
  ReturnType<typeof generateText>
>["responseMessages"];
export type LlmOutputPart = LlmOutput[number];

export interface LlmContext {
  history: readonly ModelMessage[];
  signal: AbortSignal;
}

export type Llm = (context: LlmContext) => Promise<LlmOutput>;

export interface CreateLlmOptions {
  instructions?: string;
  model?: LanguageModel;
  tools?: AgentTools;
}

const retryableDefaultLlmStatusCodes = [
  401, 403, 408, 409, 425, 429, 500, 502, 503, 504,
];
const retryableDefaultLlmMessagePattern =
  /api key|auth|econnreset|fetch failed|forbidden|network|quota|rate.?limit|temporar|timeout|unauthori[sz]ed/i;

let defaultLlmApiKeyIndex = 0;

export const defaultModel = createDefaultModel(env.AI_API_KEY);

export function createLlm({
  model,
  instructions,
  tools,
}: CreateLlmOptions = {}): Llm {
  return ({ history, signal }) => {
    if (model) {
      return generateWithModel({ history, instructions, model, signal, tools });
    }

    return generateWithDefaultModel({ history, instructions, signal, tools });
  };
}

interface GenerateWithModelOptions {
  history: readonly ModelMessage[];
  instructions?: string;
  model: LanguageModel;
  signal: AbortSignal;
  tools?: AgentTools;
}

type GenerateWithDefaultModelOptions = Omit<GenerateWithModelOptions, "model">;

async function generateWithModel({
  history,
  instructions,
  model,
  signal,
  tools,
}: GenerateWithModelOptions): Promise<LlmOutput> {
  const { responseMessages } = await generateText({
    abortSignal: signal,
    instructions,
    messages: [...history],
    model,
    tools,
  });

  return responseMessages;
}

async function generateWithDefaultModel({
  history,
  instructions,
  signal,
  tools,
}: GenerateWithDefaultModelOptions): Promise<LlmOutput> {
  const attemptCount = Math.max(env.AI_API_KEYS.length, 1);

  for (let attempt = 0; attempt < attemptCount; attempt += 1) {
    try {
      return await generateWithModel({
        history,
        instructions,
        model: createDefaultModel(getNextDefaultLlmApiKey()),
        signal,
        tools,
      });
    } catch (error) {
      if (attempt === attemptCount - 1 || !isRetryableDefaultLlmError(error)) {
        throw error;
      }
    }
  }

  throw new Error("Default LLM generation failed without returning a result.");
}

function createDefaultModel(apiKey: string | undefined): LanguageModel {
  const provider = createOpenAICompatible({
    name: "custom",
    apiKey,
    baseURL: env.AI_BASE_URL,
  });

  return provider(env.AI_MODEL);
}

function getNextDefaultLlmApiKey(): string | undefined {
  if (env.AI_API_KEYS.length === 0) {
    return env.AI_API_KEY;
  }

  const apiKey =
    env.AI_API_KEYS[defaultLlmApiKeyIndex % env.AI_API_KEYS.length];
  defaultLlmApiKeyIndex = (defaultLlmApiKeyIndex + 1) % env.AI_API_KEYS.length;

  return apiKey;
}

function isRetryableDefaultLlmError(error: unknown): boolean {
  const status = readErrorStatus(error);

  if (status !== undefined && retryableDefaultLlmStatusCodes.includes(status)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);

  return retryableDefaultLlmMessagePattern.test(message);
}

function readErrorStatus(error: unknown): number | undefined {
  const record = readRecord(error);

  if (!record) {
    return;
  }

  const response = readRecord(record.response);
  const cause = readRecord(record.cause);

  return (
    readStatusValue(record.statusCode) ??
    readStatusValue(record.status) ??
    readStatusValue(response?.status) ??
    readStatusValue(cause?.statusCode) ??
    readStatusValue(cause?.status)
  );
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }

  return value as Record<string, unknown>;
}

function readStatusValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}
