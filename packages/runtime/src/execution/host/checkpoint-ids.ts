import type { CheckpointPhase } from "./types";

export function createCheckpointId({
  phase,
  runId,
  version,
}: {
  readonly phase: CheckpointPhase;
  readonly runId: string;
  readonly version: number;
}): string {
  return `checkpoint:${encodeCheckpointIdPart(runId)}:${version}:${phase}:${crypto.randomUUID()}`;
}

function encodeCheckpointIdPart(value: string): string {
  return encodeURIComponent(value);
}
