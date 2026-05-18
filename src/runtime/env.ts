import { config } from "dotenv";

config({ override: true, quiet: true });

export function parseEnvTokenPool(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

const aiApiKeys = parseEnvTokenPool(process.env.AI_API_KEY);

export const env = {
  AI_API_KEY: aiApiKeys[0],
  AI_API_KEYS: aiApiKeys,
  AI_BASE_URL:
    process.env.AI_BASE_URL?.trim() || "https://apis.opengateway.ai/v1",
  AI_MODEL: process.env.AI_MODEL?.trim() || "minimax/MiniMax-M2.7",
} as const;
