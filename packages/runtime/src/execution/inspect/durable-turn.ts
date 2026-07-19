import type { ThreadStore } from "../../thread/store/types";
import type {
  AgentHost,
  Checkpoint,
  HostStore,
  TurnStatus,
} from "../host/types";

export type DurableTurnInspectionSource = AgentHost | HostStore | ThreadStore;

interface RecordedDurableTurnInspection {
  readonly checkpointVersion: number;
  readonly latestCheckpoint: Checkpoint | null;
  readonly runId: string;
  readonly state: "checkpointed" | "no-checkpoint";
  readonly status: TurnStatus;
  readonly threadKey: string;
}

export type DurableTurnInspectionResult =
  | {
      readonly runId: string;
      readonly state: "unsupported";
    }
  | {
      readonly runId: string;
      readonly state: "unknown-run";
    }
  | RecordedDurableTurnInspection;

/** Read one atomic run/checkpoint snapshot without granting recovery authority. */
export async function inspectDurableTurn(
  source: DurableTurnInspectionSource,
  runId: string
): Promise<DurableTurnInspectionResult> {
  const store = hostStore(source);
  if (!store) {
    return { runId, state: "unsupported" };
  }

  return await store.transaction(async (transaction) => {
    const turn = await transaction.turns.get(runId);
    if (!turn) {
      return { runId, state: "unknown-run" };
    }

    const latestCheckpoint = await transaction.checkpoints.latest(runId);
    return {
      checkpointVersion: turn.checkpointVersion,
      latestCheckpoint,
      runId,
      state: latestCheckpoint ? "checkpointed" : "no-checkpoint",
      status: turn.status,
      threadKey: turn.threadKey,
    };
  });
}

function hostStore(source: DurableTurnInspectionSource): HostStore | undefined {
  if (isHostStore(source)) {
    return source;
  }
  if (isAgentHost(source)) {
    return source.store;
  }
  return;
}

function isAgentHost(source: DurableTurnInspectionSource): source is AgentHost {
  return "store" in source && isHostStore(source.store);
}

function isHostStore(source: object): source is HostStore {
  return (
    "checkpoints" in source && "transaction" in source && "turns" in source
  );
}
