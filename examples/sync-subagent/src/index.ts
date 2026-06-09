import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createEnv } from "@t3-oss/env-core";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { createCoordinatorAgent, createReaderAgent } from "./agents";

loadEnv({ path: ".env", quiet: true, override: true });
const env = createEnv({
  runtimeEnv: process.env,
  server: {
    AI_API_KEY: z.string().trim().min(1),
    AI_BASE_URL: z.url().trim().default("https://apis.opengateway.ai/v1"),
    AI_MODEL: z.string().trim().min(1).default("minimax/MiniMax-M2.7"),
  },
});

const provider = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
});
const model = provider(env.AI_MODEL);
const sessionKey = "default";
const reader = createReaderAgent(model);
const coordinator = createCoordinatorAgent(model, { readerAgent: reader, sessionKey });

const run = await coordinator.session(sessionKey).send(
  "Pro 플랜 환불 정책을 알려줘. reader가 읽은 근거 파일 경로도 함께 알려줘."
);

for await (const event of run.events()) {
  console.log(event);
}