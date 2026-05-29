import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Agent } from "@minpeter/pss-runtime";
import { createEnv } from "@t3-oss/env-core";
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

const provider = createOpenAICompatible({
  name: "custom",
  apiKey: env.AI_API_KEY,
  baseURL: env.AI_BASE_URL,
});

const agent = await Agent.create({
  model: provider(env.AI_MODEL),
  instructions: "Answer briefly.",
});

const session = agent.session("default");
const run = await session.send("Write a short summary.");
let steered = false;

for await (const event of run.events()) {
  console.log(event);

  if (event.type === "step-end" && !steered) {
    steered = true;
    await session.steer("Also mention the main tradeoff.");
  }
}
