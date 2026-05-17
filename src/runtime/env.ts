import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { loadEnvFile } from "./env-file";

loadEnvFile();

export const env = createEnv({
  server: {
    AI_MODEL: z.string().min(1).default("openai/gpt-5.5"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
