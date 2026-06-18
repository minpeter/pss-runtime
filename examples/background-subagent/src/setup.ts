import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Agent, SessionHandle } from "@minpeter/pss-runtime";
import { parentSessionNamespace } from "@minpeter/pss-runtime/namespace";
import { createEnv } from "@t3-oss/env-core";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { createCoordinatorAgent, createReaderAgent } from "./agents";
import { createAppAgent } from "./app-agent";
import { type LocalHost, localHost } from "./local-host";

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
  readonly host: LocalHost;
  readonly reader: Agent;
  readonly session: SessionHandle;
  readonly sessionKey: string;
}

export function createExampleRuntime(sessionKey = "default"): ExampleRuntime {
  let coordinator!: Agent;
  let reader!: Agent;
  const coordinatorNamespace = "coordinator";
  const ownerNamespace = parentSessionNamespace(
    coordinatorNamespace,
    sessionKey
  );

  const host = localHost({
    agent: () =>
      createAppAgent({
        coordinator,
        host,
        ownerNamespace,
        parentSessionKey: sessionKey,
        reader,
      }),
  });

  reader = createReaderAgent(model, host);
  coordinator = createCoordinatorAgent(model, {
    executionHost: host,
    host,
    sessionKey,
  });

  return {
    coordinator,
    host,
    reader,
    session: coordinator.session(sessionKey),
    sessionKey,
  };
}
