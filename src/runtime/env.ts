import "dotenv/config";

export const env = {
  AI_MODEL: process.env.AI_MODEL?.trim() || "openai/gpt-5.5",
} as const;
