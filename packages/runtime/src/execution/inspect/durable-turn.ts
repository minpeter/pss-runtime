import type { DurableBackgroundHost } from "../host/capabilities";
import type {
  AgentHost,
  Checkpoint,
  ExecutionStore,
  TurnRecord,
  TurnStatus,
} from "../host/types";

export type DurableTurnInspectionSource = AgentHost | ExecutionStore;

export type DurableTurnInspectionResult =
  | {
      readonly runId: string;
      readonly state: "unsupported";
    }
  | {
      readonly runId: string;
      readonly state: "unknown-run";
    }
  | {
      readonly checkpointVersion: number;
      readonly latestCheckpoint: null;
      readonly runId: string;
      readonly state: "no-checkpoint";
      readonly status: TurnStatus;
      readonly threadKey: string;
      readonly turn: TurnRecord;
    }
  | {
      readonly checkpointVersion: number;
      readonly latestCheckpoint: Checkpoint;
      readonly runId: string;
      readonly state: "checkpointed";
      readonly status: TurnStatus;
      readonly threadKey: string;
      readonly turn: TurnRecord;
    };

export async function inspectDurableTurn(
  source: DurableTurnInspectionSource,
  runId: string
): Promise<DurableTurnInspectionResult> {
  const store = executionStoreFromSource(source);
  if (!store) {
    return { runId, state: "unsupported" };
  }

  return await store.transaction(async (tx) => {
    const turn = await tx.turns.get(runId);
    if (!turn) {
      return { runId, state: "unknown-run" };
    }

    const checkpoint = await tx.checkpoints.latest(runId);
    if (!checkpoint) {
      return {
        checkpointVersion: turn.checkpointVersion,
        latestCheckpoint: null,
        runId,
        state: "no-checkpoint",
        status: turn.status,
        threadKey: turn.threadKey,
        turn,
      };
    }

    return {
      checkpointVersion: turn.checkpointVersion,
      latestCheckpoint: checkpoint,
      runId,
      state: "checkpointed",
      status: turn.status,
      threadKey: turn.threadKey,
      turn,
    };
  });
}

function executionStoreFromSource(
  source: DurableTurnInspectionSource
): ExecutionStore | undefined {
  if (isExecutionStore(source)) {
    return source;
  }

  switch (source.kind) {
    case "durable-background":
      return executionStoreFromDurableBackgroundHost(source);
    case "execution":
      return source.store;
    case "thread":
      return;
    default:
      return assertNeverHost(source);
  }
}

function executionStoreFromDurableBackgroundHost(
  source: DurableBackgroundHost
): ExecutionStore {
  return {
    checkpoints: source.checkpointStore,
    events: source.eventStore,
    notifications: source.notificationInbox,
    threads: source.threadStore,
    transaction: source.transaction,
    turns: source.turnStore,
  };
}

function isExecutionStore(
  source: DurableTurnInspectionSource
): source is ExecutionStore {
  return "turns" in source && "checkpoints" in source;
}

function assertNeverHost(host: never): never {
  throw new Error(
    `Unsupported durable turn inspection source: ${JSON.stringify(host)}`
  );
}
