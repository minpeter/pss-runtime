const THREAD_EXECUTION_RUN_PREFIX = "turn:v1:";

export interface ThreadExecutionRunIdentity {
  readonly threadKey: string;
  readonly turnId: string;
}

export function createThreadExecutionRunId({
  threadKey,
  turnId,
}: ThreadExecutionRunIdentity): string {
  return `${THREAD_EXECUTION_RUN_PREFIX}${encodeURIComponent(threadKey)}:${encodeURIComponent(turnId)}`;
}
