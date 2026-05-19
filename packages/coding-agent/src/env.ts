import { createEnv, type StandardSchemaV1 } from "@t3-oss/env-core";
import { z } from "zod";

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL =
  "https://apis.opengateway.ai/v1";
export const DEFAULT_OPENAI_COMPATIBLE_MODEL_ID = "minimax/MiniMax-M2.7";
export const REQUIRED_TINYFISH_API_KEY_ERROR =
  "TINYFISH_API_KEY is required to use the built-in TinyFish web tools.";

export type CodingAgentRuntimeEnv = Record<
  string,
  boolean | number | string | undefined
>;

export interface ReadCodingAgentEnvOptions {
  runtimeEnv?: CodingAgentRuntimeEnv;
}

export type OpenAICompatibleModelEnv = ReturnType<
  typeof readOpenAICompatibleModelEnv
>;

const requiredTrimmedString = z.string().trim().min(1);
const openAICompatibleBaseUrl = z
  .string()
  .trim()
  .url()
  .default(DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
const openAICompatibleModelId = requiredTrimmedString.default(
  DEFAULT_OPENAI_COMPATIBLE_MODEL_ID
);
const tinyFishApiKeyPool = z
  .string()
  .transform((value) =>
    value
      .split(";")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
  )
  .refine((apiKeys) => apiKeys.length > 0, {
    message: "Expected at least one non-empty TinyFish API key.",
  });

export function readOpenAICompatibleModelEnv({
  runtimeEnv = process.env,
}: ReadCodingAgentEnvOptions = {}) {
  return createEnv({
    emptyStringAsUndefined: true,
    onValidationError: (issues) => {
      throw createValidationError("OpenAI-compatible model", issues);
    },
    runtimeEnv: copyRuntimeEnv(runtimeEnv),
    server: {
      AI_API_KEY: requiredTrimmedString,
      AI_BASE_URL: openAICompatibleBaseUrl,
      AI_MODEL: openAICompatibleModelId,
    },
  });
}

export function readTinyFishApiKeyPoolFromEnv({
  runtimeEnv = process.env,
}: ReadCodingAgentEnvOptions = {}): string[] {
  const env = createEnv({
    emptyStringAsUndefined: true,
    onValidationError: (issues) => {
      throw createValidationError("TinyFish", issues);
    },
    runtimeEnv: copyRuntimeEnv(runtimeEnv),
    server: {
      TINYFISH_API_KEY: tinyFishApiKeyPool,
    },
  });

  return env.TINYFISH_API_KEY;
}

function copyRuntimeEnv(
  runtimeEnv: CodingAgentRuntimeEnv
): CodingAgentRuntimeEnv {
  return { ...runtimeEnv };
}

function createValidationError(
  scope: string,
  issues: readonly StandardSchemaV1.Issue[]
): Error {
  const issueSummary = issues.map(formatIssue).join("; ");
  const prefix =
    scope === "TinyFish"
      ? REQUIRED_TINYFISH_API_KEY_ERROR
      : `${scope} environment validation failed.`;

  return new Error(`${prefix} ${issueSummary}`.trim());
}

function formatIssue(issue: StandardSchemaV1.Issue): string {
  const path = issue.path?.map(formatPathSegment).join(".");

  return path ? `${path}: ${issue.message}` : issue.message;
}

function formatPathSegment(
  segment: PropertyKey | StandardSchemaV1.PathSegment
): string {
  return typeof segment === "object" && segment !== null
    ? String(segment.key)
    : String(segment);
}
