import type { AgentEvent } from "@minpeter/pss-runtime";
import type { ExecutionHost, RunKind } from "@minpeter/pss-runtime/execution";

export function backgroundTaskIdFromEvents(
  events: readonly AgentEvent[]
): string {
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
  }

  throw new Error("Background task id was not emitted.");
}

export function backgroundNotificationKey(
  sessionKey: string,
  taskId: string
): string {
  return `background-complete:${sessionKey}:${taskId}`;
}

export async function createQueuedRun(
  host: ExecutionHost,
  options: {
    readonly kind: RunKind;
    readonly runId: string;
    readonly sessionKey: string;
  }
): Promise<void> {
  await host.store.runs.create({
    checkpointVersion: 0,
    kind: options.kind,
    rootRunId: options.runId,
    runId: options.runId,
    sessionKey: options.sessionKey,
    status: "queued",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
