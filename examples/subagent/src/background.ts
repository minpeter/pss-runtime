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

const researcher = new Agent({
  name: "researcher",
  description: "Runs longer research tasks for the coordinator.",
  model,
  instructions:
    "Research the requested topic. Return one short result with the key evidence.",
});

const coordinator = new Agent({
  model,
  instructions:
    "Coordinate the task. Start researcher work with delegate_to_researcher({ prompt: 'Give one sentence on why task IDs matter for background subagents.', run_in_background: true }), save the returned task_id, then call background_output({ task_id, block: true }) before answering. Use background_cancel({ task_id }) only when the background task is no longer needed.",
  subagents: [researcher],
});

const run = await coordinator.send(
  "Start the one-sentence background researcher task, retrieve it with background_output, then summarize the result."
);

for await (const event of run.events()) {
  console.log(event);
}
