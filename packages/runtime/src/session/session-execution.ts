import type {
  CheckpointPhase,
  ExecutionHost,
  RunRecord,
  RunStatus,
} from "../execution/types";
import type {
  RuntimeToolExecutionCheckpoint,
  RuntimeToolExecutionContext,
} from "../llm";
import type { SessionState } from "./session-state";

const maxCheckpointWriteAttempts = 5;

export interface SessionExecutionOptions {
  readonly executionHost?: ExecutionHost;
}

export interface SessionExecutionRun {
  complete(status: SessionExecutionTerminalStatus): Promise<void>;
  readonly runId: string;
  readonly toolExecution: RuntimeToolExecutionContext;
}

export type SessionExecutionTerminalStatus = Extract<
  RunStatus,
  "cancelled" | "completed" | "error" | "needs-recovery"
>;

export class SessionExecutionCheckpointError extends Error {
  constructor(runId: string, expectedVersion: number, currentVersion: number) {
    super(
      `Session execution run ${runId} checkpoint conflict: expected ${expectedVersion}, got ${currentVersion}`
    );
    this.name = "SessionExecutionCheckpointError";
  }
}

export async function startSessionExecutionRun({
  executionHost,
  sessionKey,
  state,
  turnId,
}: {
  readonly executionHost?: ExecutionHost;
  readonly sessionKey: string;
  readonly state: SessionState;
  readonly turnId: string;
}): Promise<SessionExecutionRun | undefined> {
  if (!executionHost) {
    return;
  }

  const runId = `turn:${sessionKey}:${turnId}`;
  const run: RunRecord = {
    checkpointVersion: 0,
    dedupeKey: runId,
    kind: "user-turn",
    rootRunId: runId,
    runId,
    sessionKey,
    status: "running",
  };
  await executionHost.store.runs.create(run);

  return {
    complete: (status) =>
      completeSessionExecutionRun({ executionHost, runId, status }),
    runId,
    toolExecution: {
      attempt: 1,
      afterTool: (checkpoint) =>
        appendToolExecutionCheckpoint({
          executionHost,
          phase: "after-tool",
          runId,
          state,
          toolCall: checkpoint,
        }),
      beforeTool: async (checkpoint) => {
        await appendToolExecutionCheckpoint({
          executionHost,
          phase: "before-tool",
          runId,
          state,
          toolCall: checkpoint,
        });
        return;
      },
      runId,
    },
  };
}

async function appendToolExecutionCheckpoint({
  executionHost,
  phase,
  runId,
  state,
  toolCall,
}: {
  readonly executionHost: ExecutionHost;
  readonly phase: Extract<CheckpointPhase, "after-tool" | "before-tool">;
  readonly runId: string;
  readonly state: SessionState;
  readonly toolCall: RuntimeToolExecutionCheckpoint & {
    readonly output?: unknown;
  };
}): Promise<void> {
  let lastConflict:
    | { readonly current: number; readonly expected: number }
    | undefined;
  for (let attempt = 0; attempt < maxCheckpointWriteAttempts; attempt += 1) {
    const run = await executionHost.store.runs.get(runId);
    if (!run) {
      throw new Error(`Session execution run ${runId} is missing.`);
    }

    const result = await executionHost.store.checkpoints.append(
      {
        checkpointId: crypto.randomUUID(),
        pendingToolCall: toolCall,
        phase,
        runId,
        runtimeState: {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        },
        sessionSnapshot: { history: state.modelSnapshot() },
        version: run.checkpointVersion + 1,
      },
      { expectedVersion: run.checkpointVersion }
    );

    if (result.ok) {
      return;
    }

    lastConflict = {
      current: result.currentVersion,
      expected: run.checkpointVersion,
    };
  }

  throw new SessionExecutionCheckpointError(
    runId,
    lastConflict?.expected ?? 0,
    lastConflict?.current ?? 0
  );
}

async function completeSessionExecutionRun({
  executionHost,
  runId,
  status,
}: {
  readonly executionHost: ExecutionHost;
  readonly runId: string;
  readonly status: SessionExecutionTerminalStatus;
}): Promise<void> {
  const run = await executionHost.store.runs.get(runId);
  if (!run) {
    return;
  }

  await executionHost.store.runs.update({ ...run, status });
}
