import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@minpeter/pss-runtime";
import { createEnv } from "@t3-oss/env-core";
import { jsonSchema, type ToolSet, tool } from "ai";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({ path: ".env", quiet: true, override: true });

const env = createEnv({
  runtimeEnv: process.env,
  server: {
    AI_API_KEY: z.string().trim().min(1),
    AI_BASE_URL: z.url().trim().default("https://apis.opengateway.ai/v1"),
    AI_MODEL: z.string().trim().min(1).default("minimax/MiniMax-M2.7"),
  },
});

const model = createOpenAICompatible({
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
  name: "custom",
})(env.AI_MODEL);

const tools = {
  get_weather: tool({
    description: "Get the current weather for a city.",
    execute: async () => ({ city: "서울", condition: "맑음", tempC: 21 }),
    inputSchema: jsonSchema({
      additionalProperties: false,
      properties: { city: { type: "string" } },
      required: ["city"],
      type: "object",
    }),
  }),
  send_email: tool({
    description: "Send an email to a recipient. Has real side effects.",
    execute: async () => ({ sent: true }),
    inputSchema: jsonSchema({
      additionalProperties: false,
      properties: {
        body: { type: "string" },
        to: { type: "string" },
      },
      required: ["body", "to"],
      type: "object",
    }),
  }),
} satisfies ToolSet;

/**
 * Fresh agent thread per eval case. Building per case keeps conversation state
 * isolated, so one case never influences another.
 */
export function evalThread() {
  return new Agent({
    instructions:
      "You are a helpful assistant. Answer in Korean. " +
      "Use get_weather for weather questions. " +
      "Never send email without confirming the exact recipient address.",
    model,
    tools,
  }).thread("eval");
}
