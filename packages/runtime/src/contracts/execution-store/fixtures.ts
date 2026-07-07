import type {
  CheckpointWriteResult,
  ExecutionStore,
  StoredAgentEvent,
  StoredThreadEvent,
  TurnRecord,
} from "../../execution";

export function createQueuedRun(runId = "run-1"): TurnRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    threadKey: "thread-1",
    status: "queued",
  };
}

export async function collectEvents(
  events: AsyncIterable<StoredAgentEvent>
): Promise<StoredAgentEvent[]> {
  const collected: StoredAgentEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

export async function collectThreadEvents(
  events: AsyncIterable<StoredThreadEvent>
): Promise<StoredThreadEvent[]> {
  const collected: StoredThreadEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

export function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function appendCheckpoint(
  store: ExecutionStore,
  expectedVersion: number
): Promise<CheckpointWriteResult> {
  return await store.checkpoints.append(
    {
      checkpointId: `checkpoint-${expectedVersion + 1}`,
      phase: "before-model",
      runId: "run-1",
      runtimeState: {},
      threadSnapshot: {},
      version: expectedVersion + 1,
    },
    { expectedVersion }
  );
}
