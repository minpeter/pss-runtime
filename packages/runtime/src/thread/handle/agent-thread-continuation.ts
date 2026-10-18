import type { JSONValue, ModelMessage } from "ai";
import { ownsAgentNamespace } from "../../agent/identity/namespace";
import { transitionTurn } from "../../execution/host/turn-status";
import type {
  AgentHost,
  Checkpoint,
  TurnRecord,
  TurnStore,
} from "../../execution/host/types";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import type { RuntimeToolExecutionCheckpointMetadata } from "../../llm/tool-execution-types";
import { createRuntimeInputState } from "../input/runtime-input";
import {
  type AgentTurn,
  BufferedAgentTurn,
  bindTurnExecutionRun,
  type ThreadContinuationOptions,
} from "../protocol/turn";
import { waitForCompactionQueue } from "../runtime/compaction-queue-deadline";
import {
  claimDurableThreadInput,
  releaseDurableThreadInputClaim,
} from "../runtime/durable-input-claims";
import {
  cancelThreadExecutionRun,
  precreateThreadExecutionRun,
  type QueuedThreadExecutionRun,
} from "../runtime/execution";
import { startThreadQueueDrain } from "../runtime/notification";
import { reserveThreadInputAdmission } from "../runtime/thread-input-admission-coordinator";
import { enqueueAgentThreadInputAdmission } from "./agent-thread-admission";
import type { AgentThreadContext } from "./agent-thread-context";
import { drainAgentThreadInputQueue } from "./agent-thread-drain";
import {
  assertAgentThreadOpen,
  ensureAgentThreadStarted,
} from "./agent-thread-lifecycle";
import { recoverThreadDurableInputClaims } from "./durable-queue-claims";

/** Session-local: queued user input always supersedes a failed generation. */
export async function continueAgentThread(
  context: AgentThreadContext,
  options: ThreadContinuationOptions = {}
): Promise<AgentTurn | undefined> {
  assertAgentThreadOpen(context);
  const signal = options.signal
    ? AbortSignal.any([context.lifetime.signal, options.signal])
    : context.lifetime.signal;
  signal.throwIfAborted();
  const host = context.execution.executionHost;
  const reservation = host
    ? reserveThreadInputAdmission(host, context.threadKey, signal)
    : undefined;
  let reservationEntered = false;
  const admission = enqueueAgentThreadInputAdmission(
    context,
    async () => {
      reservationEntered = true;
      const admit = () => admitContinuation(context, signal);
      return await (reservation ? reservation(admit) : admit());
    },
    signal
  );
  try {
    return await waitForCompactionQueue(admission, signal);
  } finally {
    // Also abandon when local FIFO cancellation prevented entering the host
    // reservation at all. Abandon preserves the previous reservation's tail.
    if (signal.aborted && !reservationEntered) {
      reservation?.abandon();
    }
  }
}

async function admitContinuation(
  context: AgentThreadContext,
  signal: AbortSignal
): Promise<AgentTurn | undefined> {
  const host = context.execution.executionHost;
  signal.throwIfAborted();
  await waitForCompactionQueue(ensureAgentThreadStarted(context), signal);
  assertAgentThreadOpen(context);
  signal.throwIfAborted();
  await recoverThreadDurableInputClaims({
    executionHost: host,
    signal,
    state: context.durableInputRecovery,
    threadKey: context.threadKey,
  });
  assertAgentThreadOpen(context);
  signal.throwIfAborted();
  if (context.turn.state.tag !== "none" || context.inputQueue.length) {
    throw busyError();
  }
  const inMemoryContinuation = context.state.continuationCheckpoint();
  if (!inMemoryContinuation) {
    return await admitPersistedContinuation(context, signal);
  }
  // Keep the serial position until the physical refresh settles. A
  // cancelled caller can stop waiting, but a late load cannot overtake B.
  await context.state.refresh();
  assertAgentThreadOpen(context);
  signal.throwIfAborted();
  if (!context.state.isContinuationCurrent(inMemoryContinuation)) {
    return;
  }
  if (inMemoryContinuation.recover) {
    inMemoryContinuation.history.splice(
      0,
      inMemoryContinuation.history.length,
      ...inMemoryContinuation.recover()
    );
  }
  signal.throwIfAborted();
  const precreated = await precreateThreadExecutionRun({
    executionHost: host,
    kind: "user-turn",
    ownerNamespace: context.execution.ownerNamespace,
    threadKey: context.threadKey,
  });
  // Storage creation is not cancellable. Retain admission ownership until
  // its result is known, then cancel only our unleased record, never queue
  // a late accepted turn after caller cancellation or disposal.
  if (signal.aborted || context.terminal.state.tag !== "open") {
    await cancelThreadExecutionRun({
      cancellation: precreated
        ? { kind: "owned", leaseId: null, runId: precreated.runId }
        : undefined,
      executionHost: host,
    });
    assertAgentThreadOpen(context);
    signal.throwIfAborted();
  }
  return enqueueContinuationTurn(
    context,
    inMemoryContinuation,
    precreated ? { kind: precreated.kind, runId: precreated.runId } : undefined
  );
}

function enqueueContinuationTurn(
  context: AgentThreadContext,
  continuation: NonNullable<
    ReturnType<AgentThreadContext["state"]["continuationCheckpoint"]>
  >,
  executionRun?: QueuedThreadExecutionRun
): BufferedAgentTurn {
  const run = new BufferedAgentTurn();
  if (executionRun) {
    bindTurnExecutionRun(run, executionRun.runId, executionRun.leaseId ?? null);
  }
  context.inputQueue.push({
    continuation,
    ...(executionRun ? { executionRun } : {}),
    initialEvents: [],
    preUserRuntimeInputs: [],
    run,
    runtimeInput: createRuntimeInputState([]),
  });
  startThreadQueueDrain(run, () => drainAgentThreadInputQueue(context));
  return run;
}

async function admitPersistedContinuation(
  context: AgentThreadContext,
  signal: AbortSignal
): Promise<AgentTurn | undefined> {
  const host = context.execution.executionHost;
  const pending = await claimDurableThreadInput({
    boundary: "turn-idle",
    executionHost: host,
    threadKey: context.threadKey,
  });
  if (pending.kind === "claimed" && pending.record) {
    await releaseDurableThreadInputClaim({
      executionHost: host,
      record: pending.record,
    });
    assertAgentThreadOpen(context);
    signal.throwIfAborted();
    throw busyError("Thread has queued durable work.");
  }
  assertAgentThreadOpen(context);
  signal.throwIfAborted();
  return await recoverPersistedThreadContinuation(context, signal);
}

export async function resumeClaimedExecutionRunOnThread(
  context: AgentThreadContext,
  executionRun: QueuedThreadExecutionRun,
  checkpoint: Checkpoint | null
): Promise<AgentTurn> {
  assertAgentThreadOpen(context);
  const signal = context.lifetime.signal;
  signal.throwIfAborted();
  return await enqueueAgentThreadInputAdmission(
    context,
    async () => {
      await waitForCompactionQueue(ensureAgentThreadStarted(context), signal);
      assertAgentThreadOpen(context);
      if (context.turn.state.tag !== "none" || context.inputQueue.length) {
        throw busyError();
      }
      const turn = await prepareClaimedContinuation(
        context,
        executionRun,
        checkpoint,
        signal
      );
      if (turn) {
        return turn;
      }
      const aborted = new BufferedAgentTurn();
      bindTurnExecutionRun(
        aborted,
        executionRun.runId,
        executionRun.leaseId ?? null
      );
      aborted.emit({ type: "turn-abort" });
      aborted.close();
      return aborted;
    },
    signal
  );
}

export const DEFAULT_MAX_TURN_CLAIM_ATTEMPTS = 5;

async function recoverPersistedThreadContinuation(
  context: AgentThreadContext,
  signal: AbortSignal
): Promise<AgentTurn | undefined> {
  const host = context.execution.executionHost;
  const turns = host?.store.turns;
  if (!(host && turns?.listByThreadKey)) {
    return;
  }
  const ownerNamespace = context.execution.ownerNamespace ?? "";
  const hasExplicitNamespace = context.execution.ownerNamespace !== undefined;
  const runs = await turns.listByThreadKey(context.threadKey);
  signal.throwIfAborted();
  const latestRun = runs
    .filter(
      (run) =>
        (run.kind === "user-turn" || run.kind === "tool-recovery") &&
        isRecordClaimableByAgent(run, ownerNamespace, hasExplicitNamespace)
    )
    .at(-1);
  if (
    !latestRun ||
    latestRun.status === "completed" ||
    latestRun.status === "cancelled" ||
    latestRun.status === "error"
  ) {
    return;
  }
  if (latestRun.status === "needs-recovery") {
    await throwIfManualToolRecovery(host, latestRun.runId, true, signal);
  }
  const claimed = await turns.claim(latestRun.runId, {
    attempt: (latestRun.lease?.attempt ?? 0) + 1,
    leaseId: crypto.randomUUID(),
    leaseMs: 300_000,
    maxAttempts: DEFAULT_MAX_TURN_CLAIM_ATTEMPTS,
    nowMs: Date.now(),
  });
  if (!claimed.ok) {
    signal.throwIfAborted();
    if (claimed.reason === "leased") {
      throw busyError();
    }
    if ((await turns.get(latestRun.runId))?.status === "needs-recovery") {
      await throwIfManualToolRecovery(host, latestRun.runId, true, signal);
    }
    return;
  }
  try {
    signal.throwIfAborted();
    const latestCheckpoint = await verifyClaimedRunCheckpoint(
      host,
      claimed.record,
      claimed.lease.leaseId,
      signal
    );
    const turn = await prepareClaimedContinuation(
      context,
      {
        kind: claimed.record.kind,
        leaseId: claimed.lease.leaseId,
        runId: claimed.record.runId,
      },
      latestCheckpoint,
      signal
    );
    assertAgentThreadOpen(context);
    signal.throwIfAborted();
    return turn;
  } catch (error) {
    if (!(error instanceof ToolExecutionNeedsRecoveryError)) {
      await releaseClaimedContinuationRun(
        turns,
        claimed.record,
        claimed.lease.leaseId
      ).catch(() => undefined);
    }
    throw error;
  }
}

async function prepareClaimedContinuation(
  context: AgentThreadContext,
  executionRun: QueuedThreadExecutionRun,
  checkpoint: Checkpoint | null,
  signal: AbortSignal
): Promise<AgentTurn | undefined> {
  await context.state.refresh();
  assertAgentThreadOpen(context);
  signal.throwIfAborted();
  const history = buildRecoveredContinuationHistory(
    context.state.modelSnapshot(),
    checkpoint
  );
  const turns = context.execution.executionHost?.store.turns;
  if (history.length === 0) {
    if (turns) {
      await transitionTurn(turns, {
        expected: {
          leaseId: executionRun.leaseId ?? null,
          status: "leased",
        },
        runId: executionRun.runId,
        update: { lease: null, status: "cancelled" },
      });
    }
    return;
  }
  context.state.setContinuationCheckpoint(history);
  const continuation = context.state.continuationCheckpoint();
  if (!continuation) {
    if (turns && executionRun.leaseId) {
      await transitionTurn(turns, {
        expected: { leaseId: executionRun.leaseId, status: "leased" },
        runId: executionRun.runId,
        update: { lease: null, status: "queued" },
      });
    }
    return;
  }
  return enqueueContinuationTurn(context, continuation, executionRun);
}

function busyError(message = "Thread has active or queued work."): Error {
  return Object.assign(new Error(message), {
    code: "THREAD_CONTINUATION_BUSY",
  });
}

export async function verifyClaimedRunCheckpoint(
  host: AgentHost,
  record: TurnRecord,
  leaseId: string,
  signal?: AbortSignal
): Promise<Checkpoint | null> {
  const latestCheckpoint = await host.store.checkpoints.latest(record.runId);
  signal?.throwIfAborted();
  const unrecoverableTool = manualRecoveryToolCheckpoint(latestCheckpoint);
  if (unrecoverableTool) {
    await transitionTurn(host.store.turns, {
      expected: { leaseId, status: record.status },
      runId: record.runId,
      update: { lease: null, status: "needs-recovery" },
    });
    throw new ToolExecutionNeedsRecoveryError(unrecoverableTool);
  }
  return latestCheckpoint;
}

export async function throwIfManualToolRecovery(
  host: AgentHost,
  runId: string,
  throwGeneric = false,
  signal?: AbortSignal
): Promise<void> {
  const latestCheckpoint = await host.store.checkpoints.latest(runId);
  signal?.throwIfAborted();
  const unrecoverableTool = manualRecoveryToolCheckpoint(latestCheckpoint);
  if (unrecoverableTool) {
    throw new ToolExecutionNeedsRecoveryError(unrecoverableTool);
  }
  if (throwGeneric) {
    throw new Error(
      `Thread execution run ${runId} requires manual recovery before continuing.`
    );
  }
}

async function releaseClaimedContinuationRun(
  turns: TurnStore,
  record: TurnRecord,
  leaseId: string
): Promise<void> {
  await transitionTurn(turns, {
    expected: { leaseId, status: record.status },
    runId: record.runId,
    update: { lease: null, status: "queued" },
  });
}

function buildRecoveredContinuationHistory(
  baseHistory: readonly ModelMessage[],
  checkpoint: Checkpoint | null
): ModelMessage[] {
  const unrecoverableTool = manualRecoveryToolCheckpoint(checkpoint);
  if (unrecoverableTool) {
    throw new ToolExecutionNeedsRecoveryError(unrecoverableTool);
  }
  const history = structuredClone([...baseHistory]);
  if (checkpoint?.phase !== "after-tool") {
    return history;
  }
  const candidate = checkpoint.runtimeState as
    | Record<string, unknown>
    | null
    | undefined;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof candidate.toolCallId !== "string" ||
    typeof candidate.toolName !== "string" ||
    (!("output" in candidate) && candidate.hasOutput !== true)
  ) {
    return history;
  }
  const toolCallId = candidate.toolCallId;
  const toolName = candidate.toolName;
  const rawOutput = "output" in candidate ? candidate.output : null;
  const alreadyInHistory = history.some(
    (message) =>
      message.role === "tool" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          "toolCallId" in part &&
          part.toolCallId === toolCallId
      )
  );
  if (alreadyInHistory) {
    return history;
  }
  history.push(
    {
      content: [
        {
          input: candidate.input ?? {},
          toolCallId,
          toolName,
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output:
            typeof rawOutput === "string"
              ? { type: "text", value: rawOutput }
              : {
                  type: "json",
                  value: (rawOutput ?? null) as JSONValue,
                },
          toolCallId,
          toolName,
          type: "tool-result",
        },
      ],
      role: "tool",
    }
  );
  return history;
}

function manualRecoveryToolCheckpoint(
  checkpoint: Checkpoint | null
): RuntimeToolExecutionCheckpointMetadata | undefined {
  if (checkpoint?.phase !== "before-tool") {
    return;
  }
  const candidate = checkpoint.pendingToolCall as
    | Record<string, unknown>
    | null
    | undefined;
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof candidate.attempt === "number" &&
    typeof candidate.idempotencyKey === "string" &&
    candidate.policy === "manual-recovery" &&
    typeof candidate.toolCallId === "string" &&
    typeof candidate.toolName === "string"
  ) {
    return {
      attempt: candidate.attempt,
      idempotencyKey: candidate.idempotencyKey,
      policy: "manual-recovery",
      toolCallId: candidate.toolCallId,
      toolName: candidate.toolName,
    };
  }
  return;
}

export function isRecordClaimableByAgent(
  run: TurnRecord,
  ownerNamespace: string,
  hasExplicitNamespace: boolean
): boolean {
  if (run.kind === "notification") {
    return ownsAgentNamespace(run.ownerNamespace, ownerNamespace);
  }
  if (run.ownerNamespace !== undefined) {
    return ownsAgentNamespace(run.ownerNamespace, ownerNamespace);
  }
  return !hasExplicitNamespace;
}
