import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AgentPlugin } from "@minpeter/pss-runtime";
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
const tracePlugin: AgentPlugin = {
  name: "trace-plugin",
  on: ({ event }) => {
    if (event.type === "turn-end") {
      console.log("");
      console.log("// plugin:turn-end //");
      console.log("");
    }
  },
};

const agent = new Agent({
  model: provider(env.AI_MODEL),
  instructions: "Answer briefly.",
  plugins: [tracePlugin],
});

const run = await agent.send(
  "Summarize in one sentence: plugins can observe runtime events."
);

for await (const event of run.events()) {
  console.log(event);
}
