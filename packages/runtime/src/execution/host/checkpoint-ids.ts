import type { CheckpointPhase } from "./types";

export function createRunCheckpointId({
  phase,
  runId,
  version,
}: {
  readonly phase: CheckpointPhase;
  readonly runId: string;
  readonly version: number;
}): string {
  return `run-checkpoint:${encodeCheckpointIdPart(runId)}:${version}:${phase}:${crypto.randomUUID()}`;
}

function encodeCheckpointIdPart(value: string): string {
  return encodeURIComponent(value);
}
