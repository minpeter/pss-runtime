import { createInMemoryExecutionHost } from "./execution/memory";
import type { ExecutionHost } from "./execution/types";
import type { AgentEvent } from "./session/events";
import type { AgentRun } from "./session/run";

interface DurableResumeAgent {
  resume(runId: string): Promise<AgentRun | null>;
}

export function backgroundNotificationKey(
  ...taskIds: readonly string[]
): string {
  return `background-complete:default:${[...taskIds].sort().join(",")}`;
}

export function createDurableTestHost(): ExecutionHost {
  const base = createInMemoryExecutionHost();
  return {
    ...base,
    capabilities: {
      ...base.capabilities,
      backgroundSubagents: "durable",
    },
  };
}

export async function collectAgentRun(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events()) {
    events.push(event);
  }

  return events;
}

export async function resumeBackgroundTask(
  agent: DurableResumeAgent,
  taskId: string
): Promise<AgentRun> {
  const run = await agent.resume(`background:${taskId}`);
  if (!run) {
    throw new Error(`Expected background run for ${taskId} to resume.`);
  }
  return run;
}

export async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function waitForSessionPromptResume(
  agent: DurableResumeAgent,
  host: ExecutionHost,
  idempotencyKey: string
): Promise<AgentRun> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const notification =
      await host.store.notifications.getByIdempotencyKey(idempotencyKey);
    if (notification) {
      const run = await agent.resume(notification.runId);
      if (run) {
        return run;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Expected session prompt resume for ${idempotencyKey}.`);
}
