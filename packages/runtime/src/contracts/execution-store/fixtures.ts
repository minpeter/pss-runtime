import type {
  CheckpointWriteResult,
  ExecutionStore,
  RunRecord,
  StoredAgentEvent,
} from "../../execution";

export function createQueuedRun(runId = "run-1"): RunRecord {
  return {
    checkpointVersion: 0,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    sessionKey: "session-1",
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
      sessionSnapshot: {},
      version: expectedVersion + 1,
    },
    { expectedVersion }
  );
}
