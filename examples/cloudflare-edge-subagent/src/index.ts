import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { AgentHost } from "@minpeter/pss-runtime";
import {
  Agent,
  type AgentEvent,
  type AgentRun,
  type SessionHandle,
} from "@minpeter/pss-runtime";
import type { ExecutionHost } from "@minpeter/pss-runtime/execution";
import { createEnv } from "@t3-oss/env-core";
import { config as loadEnv } from "dotenv";
import { z } from "zod";
import {
  ackScheduledCloudflareRun,
  ackScheduledCloudflareSessionPrompt,
  createCloudflareDurableObjectHost,
  InMemoryCloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareSessionPrompts,
} from "./cloudflare-host";

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

const sessionKey = "room:demo:user:edge";
const cloudflareStorePrefix = "cloudflare-edge-subagent-demo";
const turns = [
  "Start background research on why stable task ids matter in edge-hosted agent turns. Return after the background task is launched.",
] as const;

await runEdgeScenario(turns);

function createCoordinator({ host }: { readonly host: AgentHost }): Agent {
  const researcher = new Agent({
    name: "researcher",
    description: "Produces compact research notes for the coordinator.",
    host,
    model,
    namespace: "edge-demo-researcher",
    instructions:
      "Answer delegated prompts in one sentence. Return only the compact result the coordinator needs.",
  });

  return new Agent({
    host,
    model,
    namespace: "edge-demo-coordinator",
    subagents: [researcher],
    instructions: [
      "Coordinate a turn-based support agent.",
      "When the user asks for background research, call delegate_to_researcher once with run_in_background: true.",
      "Do not call background_output until a <system-reminder> says the background task completed.",
      "After the reminder, call background_output with block: true and return a concise final answer.",
    ].join(" "),
  });
}

async function runEdgeScenario(inputs: readonly string[]): Promise<void> {
  const storage = new InMemoryCloudflareDurableObjectStorage();

  for (const [index, input] of inputs.entries()) {
    const host = createCloudflareDurableObjectHost({
      prefix: cloudflareStorePrefix,
      storage,
    });
    const coordinator = createCoordinator({ host });
    const session = coordinator.session(sessionKey);

    const launchEvents = await runTurn({
      input,
      label: `edge turn ${index + 1}`,
      session,
    });
    const taskId = backgroundTaskIdFromEvents(launchEvents);
    const notificationKey = backgroundNotificationKey(taskId);

    const resumedHost = createCloudflareDurableObjectHost({
      prefix: cloudflareStorePrefix,
      storage,
    });
    const resumedCoordinator = createCoordinator({
      host: resumedHost,
    });
    await drainCloudflareScheduledWork(resumedCoordinator, storage);
    const duplicate = await resumedCoordinator.resume(
      await notificationRunId(resumedHost, notificationKey)
    );
    console.log({ duplicateSessionPromptIgnored: duplicate === null });
  }
}

async function runTurn({
  input,
  label,
  session,
}: {
  readonly input: string;
  readonly label: string;
  readonly session: SessionHandle;
}): Promise<AgentEvent[]> {
  console.log(`\n=== ${label} ===`);
  console.log(`user: ${input}`);
  return await drainRun(await session.send(input));
}

async function drainRun(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
    console.log(event);
  }
  return events;
}

async function drainCloudflareScheduledWork(
  agent: Agent,
  storage: InMemoryCloudflareDurableObjectStorage
): Promise<void> {
  const runIds = await listScheduledCloudflareRuns(storage, {
    prefix: cloudflareStorePrefix,
  });
  for (const runId of runIds) {
    const run = await agent.resume(runId);
    if (run) {
      await drainRun(run);
    }
    await ackScheduledCloudflareRun(storage, runId, {
      prefix: cloudflareStorePrefix,
    });
  }

  const prompts = await listScheduledCloudflareSessionPrompts(storage, {
    prefix: cloudflareStorePrefix,
  });
  for (const prompt of prompts) {
    const runId =
      prompt.runId ??
      (prompt.idempotencyKey
        ? await notificationRunId(
            createCloudflareDurableObjectHost({
              prefix: cloudflareStorePrefix,
              storage,
            }),
            prompt.idempotencyKey
          )
        : undefined);
    if (!runId) {
      throw new Error("Scheduled session prompt did not resolve to a run id.");
    }

    const run = await agent.resume(runId);
    if (run) {
      await drainRun(run);
    }
    await ackScheduledCloudflareSessionPrompt(storage, prompt, {
      prefix: cloudflareStorePrefix,
    });
  }
}

function backgroundTaskIdFromEvents(events: readonly AgentEvent[]): string {
  for (const event of events) {
    if (event.type !== "tool-result") {
      continue;
    }
    const output = event.output;
    if (
      isRecord(output) &&
      output.type === "json" &&
      isRecord(output.value) &&
      typeof output.value.task_id === "string"
    ) {
      return output.value.task_id;
    }

    if (isRecord(output) && typeof output.task_id === "string") {
      return output.task_id;
    }
  }

  throw new Error("Background task id was not emitted.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function backgroundNotificationKey(taskId: string): string {
  return `background-complete:${sessionKey}:${taskId}`;
}

async function notificationRunId(
  host: ExecutionHost,
  notificationKey: string
): Promise<string> {
  const notification =
    await host.store.notifications.getByIdempotencyKey(notificationKey);
  if (!notification) {
    throw new Error(`Notification ${notificationKey} was not enqueued.`);
  }
  return notification.runId;
}
