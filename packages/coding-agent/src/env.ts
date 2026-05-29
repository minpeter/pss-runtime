import { createEnv, type StandardSchemaV1 } from "@t3-oss/env-core";
import { z } from "zod";

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL =
  "https://apis.opengateway.ai/v1";
export const DEFAULT_OPENAI_COMPATIBLE_MODEL_ID = "minimax/MiniMax-M2.7";
export const DEFAULT_LOOK_AT_MAX_OUTPUT_CHARS = 2000;
export const DEFAULT_LOOK_AT_MAX_IMAGE_BYTES = 10_485_760;
const TINYFISH_API_KEY_ERROR =
  "TINYFISH_API_KEY is required to use the built-in TinyFish web tools.";

export type CodingAgentRuntimeEnv = Record<string, string | undefined>;

export type LookAtModelEnv =
  | {
      apiKey: string;
      baseUrl: string;
      enabled: true;
      maxImageBytes: number;
      maxOutputChars: number;
      model: string;
    }
  | {
      apiKey: undefined;
      baseUrl: undefined;
      enabled: false;
      maxImageBytes: number;
      maxOutputChars: number;
      model: undefined;
    };

interface ReadCodingAgentEnvOptions {
  runtimeEnv?: CodingAgentRuntimeEnv;
}

export function readOpenAICompatibleModelEnv({
  runtimeEnv = process.env,
}: ReadCodingAgentEnvOptions = {}) {
  return createEnv({
    emptyStringAsUndefined: true,
    onValidationError: failEnvValidation(
      "OpenAI-compatible model environment validation failed."
    ),
    runtimeEnv: { ...runtimeEnv },
    server: {
      AI_API_KEY: z.string().trim().min(1),
      AI_BASE_URL: z.url().trim().default(DEFAULT_OPENAI_COMPATIBLE_BASE_URL),
      AI_MODEL: z
        .string()
        .trim()
        .min(1)
        .default(DEFAULT_OPENAI_COMPATIBLE_MODEL_ID),
    },
  });
}

export function readLookAtModelEnv({
  runtimeEnv = process.env,
}: ReadCodingAgentEnvOptions = {}): LookAtModelEnv {
  const candidate = { ...runtimeEnv };
  const model = emptyStringAsUndefined(candidate.PSS_LOOK_AT_MODEL);

  if (model === undefined) {
    return {
      enabled: false as const,
      model: undefined,
      baseUrl: undefined,
      apiKey: undefined,
      maxOutputChars: DEFAULT_LOOK_AT_MAX_OUTPUT_CHARS,
      maxImageBytes: DEFAULT_LOOK_AT_MAX_IMAGE_BYTES,
    };
  }

  const env = createEnv({
    emptyStringAsUndefined: true,
    onValidationError: failEnvValidation(
      "look_at model environment validation failed."
    ),
    runtimeEnv: {
      ...candidate,
      PSS_LOOK_AT_API_KEY:
        emptyStringAsUndefined(candidate.PSS_LOOK_AT_API_KEY) ??
        candidate.AI_API_KEY,
      PSS_LOOK_AT_BASE_URL:
        emptyStringAsUndefined(candidate.PSS_LOOK_AT_BASE_URL) ??
        candidate.AI_BASE_URL,
    },
    server: {
      PSS_LOOK_AT_API_KEY: z.string().trim().min(1),
      PSS_LOOK_AT_BASE_URL: z
        .url()
        .trim()
        .default(DEFAULT_OPENAI_COMPATIBLE_BASE_URL),
      PSS_LOOK_AT_MAX_IMAGE_BYTES: positiveIntegerFromEnv(
        DEFAULT_LOOK_AT_MAX_IMAGE_BYTES
      ),
      PSS_LOOK_AT_MAX_OUTPUT_CHARS: positiveIntegerFromEnv(
        DEFAULT_LOOK_AT_MAX_OUTPUT_CHARS
      ),
      PSS_LOOK_AT_MODEL: z.string().trim().min(1),
    },
  });

  return {
    enabled: true as const,
    model: env.PSS_LOOK_AT_MODEL,
    baseUrl: env.PSS_LOOK_AT_BASE_URL,
    apiKey: env.PSS_LOOK_AT_API_KEY,
    maxOutputChars: env.PSS_LOOK_AT_MAX_OUTPUT_CHARS,
    maxImageBytes: env.PSS_LOOK_AT_MAX_IMAGE_BYTES,
  };
}

export function readTinyFishApiKeyPoolFromEnv({
  runtimeEnv = process.env,
}: ReadCodingAgentEnvOptions = {}): string[] {
  const env = createEnv({
    emptyStringAsUndefined: true,
    onValidationError: failEnvValidation(TINYFISH_API_KEY_ERROR),
    runtimeEnv: { ...runtimeEnv },
    server: {
      TINYFISH_API_KEY: z
        .string()
        .transform((value) =>
          value
            .split(";")
            .map((segment) => segment.trim())
            .filter((segment) => segment.length > 0)
        )
        .refine((apiKeys) => apiKeys.length > 0, {
          message: "Expected at least one non-empty TinyFish API key.",
        }),
    },
  });

  return env.TINYFISH_API_KEY;
}

function failEnvValidation(prefix: string) {
  return (issues: readonly StandardSchemaV1.Issue[]): never => {
    const summary = issues
      .map(({ message, path }) => {
        const segment = path?.[0];
        const key =
          typeof segment === "object" && segment !== null
            ? segment.key
            : segment;

        return key === undefined ? message : `${String(key)}: ${message}`;
      })
      .join("; ");

    throw new Error(`${prefix} ${summary}`.trim());
  };
}

function emptyStringAsUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function positiveIntegerFromEnv(defaultValue: number) {
  return z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) {
        return defaultValue;
      }

      const parsed = Number(value);
      if (!(Number.isInteger(parsed) && parsed > 0)) {
        ctx.addIssue({
          code: "custom",
          message: "Expected a positive integer.",
        });
        return z.NEVER;
      }

      return parsed;
    });
}
