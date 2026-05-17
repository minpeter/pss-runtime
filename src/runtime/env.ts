import "dotenv/config";

export const env = {
  AI_API_KEY: process.env.AI_API_KEY?.trim() || undefined,
  AI_BASE_URL:
    process.env.AI_BASE_URL?.trim() || "https://apis.opengateway.ai/v1",
  AI_MODEL: process.env.AI_MODEL?.trim() || "openai/gpt-5.5",
} as const;
