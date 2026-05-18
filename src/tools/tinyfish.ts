import { parseEnvTokenPool } from "../runtime/env";

const requiredApiKeyError =
  "TINYFISH_API_KEY is required to use the built-in TinyFish web tools.";

let tinyFishApiKeyPoolSource: string | undefined;
let tinyFishApiKeyIndex = 0;

export function getTinyFishApiKey(): string {
  const apiKeyPoolSource = process.env.TINYFISH_API_KEY;

  if (apiKeyPoolSource !== tinyFishApiKeyPoolSource) {
    tinyFishApiKeyPoolSource = apiKeyPoolSource;
    tinyFishApiKeyIndex = 0;
  }

  const apiKeys = parseEnvTokenPool(apiKeyPoolSource);

  if (apiKeys.length === 0) {
    throw new Error(requiredApiKeyError);
  }

  const apiKey = apiKeys[tinyFishApiKeyIndex % apiKeys.length] ?? apiKeys[0];
  tinyFishApiKeyIndex = (tinyFishApiKeyIndex + 1) % apiKeys.length;

  return apiKey;
}

export async function parseTinyFishJsonResponse<T>(
  response: Response,
  serviceName: string
): Promise<T> {
  const bodyText = await response.text();
  const body = parseJsonBody(bodyText);

  if (!response.ok) {
    throw new Error(
      `TinyFish ${serviceName} request failed with HTTP ${response.status}: ${readErrorMessage(body)}`
    );
  }

  return body as T;
}

export function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return;
  }

  return value.filter((item): item is string => typeof item === "string");
}

function parseJsonBody(bodyText: string): unknown {
  if (!bodyText.trim()) {
    return {};
  }

  try {
    return JSON.parse(bodyText) as unknown;
  } catch (error) {
    throw new Error(
      `TinyFish returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function readErrorMessage(body: unknown): string {
  const error = readObject(readObject(body).error);
  const message = readOptionalString(error.message);

  if (message) {
    return message;
  }

  return JSON.stringify(body);
}
