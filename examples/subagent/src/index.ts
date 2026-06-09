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
const model = provider(env.AI_MODEL);
const researcher = {
  description: "Researches facts and returns concise evidence.",
  agent: new Agent({
    instructions:
      "Research facts and return concise evidence. In this example, runtime subagents are specialist agents exposed to the parent model as delegate tools.",
    model,
    namespace: "researcher",
  }),
  name: "researcher",
};

const coordinator = new Agent({
  instructions: "Coordinate work and delegate when useful.",
  model,
  subagents: [researcher],
});

const run = await coordinator.send(
  "Ask the researcher for one concise fact about runtime subagents in this example, then summarize it."
);

for await (const event of run.events()) {
  console.log(event);
}
