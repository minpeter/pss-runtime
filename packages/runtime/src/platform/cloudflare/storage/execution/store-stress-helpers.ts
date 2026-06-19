import type { RunRecord } from "../../../../execution";
import type { AgentEvent } from "../../../../index";
import { createCloudflareDurableObjectHost } from "../../index";
import type { InMemoryCloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";

export async function hostLoadFinalThread(
  storage: InMemoryCloudflareDurableObjectStorage,
  prefix: string,
  threadKey: string
) {
  const host = createCloudflareDurableObjectHost({ prefix, storage });
  return await host.store.threads.load(threadKey);
}

export function runRecord(input: {
  readonly runId: string;
  readonly threadKey: string;
}): RunRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: input.runId,
    runId: input.runId,
    status: "queued",
    threadKey: input.threadKey,
  };
}

export function eventRecord(type: "step-start" | "step-end"): AgentEvent {
  if (type === "step-start") {
    return { type: "step-start" };
  }
  return { type: "step-end" };
}
