import { createEnv, type StandardSchemaV1 } from "@t3-oss/env-core";
import { z } from "zod";

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL =
  "https://apis.opengateway.ai/v1";
export const DEFAULT_OPENAI_COMPATIBLE_MODEL_ID = "minimax/MiniMax-M2.7";

export type CodingAgentRuntimeEnv = Record<string, string | undefined>;

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
