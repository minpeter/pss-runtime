import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Agent, ThreadHandle } from "@minpeter/pss-runtime";
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

export interface ExampleRuntime {
  readonly coordinator: Agent;
  readonly reader: Agent;
  readonly sessionKey: string;
  readonly thread: ThreadHandle;
}

export function createExampleRuntime(sessionKey = "default"): ExampleRuntime {
  const reader = createReaderAgent(model);
  const coordinator = createCoordinatorAgent(model, {
    readerAgent: reader,
    sessionKey,
  });

  return {
    coordinator,
    reader,
    sessionKey,
    thread: coordinator.thread(sessionKey),
  };
}
