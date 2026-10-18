import type { JSONValue, ModelMessage } from "ai";
import { ownsAgentNamespace } from "../../agent/identity/namespace";
import { createThreadExecutionRunId } from "../../execution/host/thread-execution-run-id";
import { transitionTurn } from "../../execution/host/turn-status";
import { TurnTransitionConflictError } from "../../execution/host/turn-transition-conflict";
import type {
  AgentHost,
  Checkpoint,
  TurnRecord,
  TurnStore,
} from "../../execution/host/types";
import { ToolExecutionNeedsRecoveryError } from "../../llm/tool-execution-checkpoint";
import type { RuntimeToolExecutionCheckpointMetadata } from "../../llm/tool-execution-types";
import { attachInputMeta } from "../input/input-meta";
import type { QueuedInput } from "../input/runtime-input";
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
import type { CompletedToolCall } from "../runtime/execution-checkpoints";
import {
  priorCompletedToolCalls,
  recordedThreadVersion,
} from "../runtime/execution-checkpoints";
import {
  registerLiveThreadInput,
  unregisterLiveThreadInput,
} from "../runtime/live-input-ownership";
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
import { inputMetaForQueuedKind } from "./durable-queue-send";
import { isThreadDrainOwned } from "./thread-drain-coordinator";

/** Session-local: queued user input always supersedes a failed generation. */
export async function continueAgentThread(
  context: AgentThreadContext,
  options: ThreadContinuationOptions = {}
): Promise<AgentTurn | undefined> {
  // Reject before creating the admission promise: a promise that rejects
  // before waitForCompactionQueue observes it would be unhandled.
  assertAgentThreadOpen(context);
  const signal = options.signal
    ? AbortSignal.any([context.lifetime.signal, options.signal])
    : context.lifetime.signal;
  signal.throwIfAborted();
  return await waitForCompactionQueue(
    runReservedContinuationAdmission(context, signal, () =>
      admitContinuation(context, signal)
    ),
    signal
  );
}

async function runReservedContinuationAdmission<T>(
  context: AgentThreadContext,
  signal: AbortSignal,
  admit: () => Promise<T>
): Promise<T> {
  assertAgentThreadOpen(context);
  signal.throwIfAborted();
  const host = context.execution.executionHost;
  const reservation = host
    ? reserveThreadInputAdmission(host, context.threadKey, signal)
    : undefined;
  let reservationEntered = false;
  try {
    return await enqueueAgentThreadInputAdmission(
      context,
      async () => {
        reservationEntered = true;
        const run = async (): Promise<T> => {
          await waitForCompactionQueue(
            ensureAgentThreadStarted(context),
            signal
          );
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
          return await admit();
        };
        return await (reservation ? reservation(run) : run());
      },
      signal
    );
  } finally {
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
  const inMemoryContinuation = context.state.continuationCheckpoint();
  if (!inMemoryContinuation) {
    if (await tryEnqueuePendingDurableInputForRun(context, undefined, signal)) {
      return;
    }
    return await recoverPersistedThreadContinuation(context, signal);
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
  return enqueuePreparedTurn(
    context,
    { continuation: inMemoryContinuation },
    precreated ? { kind: precreated.kind, runId: precreated.runId } : undefined
  );
}

function enqueuePreparedTurn(
  context: AgentThreadContext,
  extra: Partial<QueuedInput>,
  executionRun?: QueuedThreadExecutionRun,
  run = new BufferedAgentTurn()
): BufferedAgentTurn {
  if (executionRun) {
    bindTurnExecutionRun(run, executionRun.runId, executionRun.leaseId ?? null);
  }
  if (extra.acceptedEvent) {
    context.events.emitProcessedEvent(run, extra.acceptedEvent);
  }
  context.inputQueue.push({
    ...extra,
    ...(extra.durableMessageId ? { durableOwner: run } : {}),
    ...(executionRun ? { executionRun } : {}),
    initialEvents: [],
    preUserRuntimeInputs: [],
    run,
    runtimeInput: createRuntimeInputState([]),
  });
  startThreadQueueDrain(run, () => drainAgentThreadInputQueue(context));
  return run;
}

export async function resumeClaimedExecutionRunOnThread(
  context: AgentThreadContext,
  executionRun: QueuedThreadExecutionRun,
  checkpoint: Checkpoint | null
): Promise<AgentTurn> {
  const signal = context.lifetime.signal;
  return await runReservedContinuationAdmission(context, signal, async () => {
    const host = context.execution.executionHost;
    if (host && isThreadDrainOwned(host, context.threadKey)) {
      throw busyError();
    }
    const pendingInputTurn = await tryEnqueuePendingDurableInputForRun(
      context,
      executionRun,
      signal
    );
    if (pendingInputTurn) {
      return pendingInputTurn;
    }
    await cancelSupersededExecutionRun(context, executionRun);
    return (
      (await prepareClaimedContinuation(
        context,
        executionRun,
        checkpoint,
        signal
      )) ?? abortedContinuationTurn(executionRun)
    );
  });
}

function abortedContinuationTurn(
  executionRun: QueuedThreadExecutionRun
): BufferedAgentTurn {
  const aborted = new BufferedAgentTurn();
  bindTurnExecutionRun(
    aborted,
    executionRun.runId,
    executionRun.leaseId ?? null
  );
  aborted.emit({ type: "turn-abort" });
  aborted.close();
  return aborted;
}

async function tryEnqueuePendingDurableInputForRun(
  context: AgentThreadContext,
  executionRun: QueuedThreadExecutionRun | undefined,
  signal: AbortSignal
): Promise<AgentTurn | undefined> {
  const host = context.execution.executionHost;
  const pending = await claimDurableThreadInput({
    boundary: "turn-idle",
    executionHost: host,
    threadKey: context.threadKey,
  });
  if (pending.kind !== "claimed" || !pending.record) {
    assertAgentThreadOpen(context);
    signal.throwIfAborted();
    return;
  }
  const { record } = pending;
  const resumable =
    executionRun !== undefined &&
    record.kind !== "steer" &&
    createThreadExecutionRunId({
      threadKey: context.threadKey,
      turnId: record.messageId,
    }) === executionRun.runId;
  // Like send(), publish live ownership before the record becomes claimable
  // again so local drains wait for this turn instead of claiming its input.
  const run = new BufferedAgentTurn();
  if (resumable) {
    registerLiveThreadInput(host, context.threadKey, record.messageId, run);
  }
  try {
    await releaseDurableThreadInputClaim({ executionHost: host, record });
    if (resumable && executionRun && host) {
      // Hand off exactly like send(): the input claim is the only ownership
      // token, so a later orphan drain can start the unleased run.
      await releaseClaimedContinuationRun(
        host.store.turns,
        { runId: executionRun.runId, status: "leased" },
        executionRun.leaseId ?? null
      );
    }
    assertAgentThreadOpen(context);
    signal.throwIfAborted();
  } catch (error) {
    unregisterLiveThreadInput(host, context.threadKey, record.messageId, run);
    throw error;
  }
  if (!(resumable && executionRun)) {
    if (
      executionRun &&
      host &&
      !(await executionRunHasPendingInput(context, executionRun))
    ) {
      // The run's own input is settled, so newer pending input supersedes
      // it. A run still waiting on its own input is queued behind instead.
      await supersedeExecutionRun(host.store.turns, executionRun);
    }
    throw busyError("Thread has queued durable work.");
  }
  return enqueuePreparedTurn(
    context,
    {
      acceptedEvent: attachInputMeta(
        record.input,
        inputMetaForQueuedKind(record.kind)
      ),
      awaitBoundaries: true,
      durableInput: true,
      durableInputKind: record.kind === "follow-up" ? "follow-up" : "send",
      durableMessageId: record.messageId,
    },
    { kind: executionRun.kind, runId: executionRun.runId },
    run
  );
}

/** Rejects agent.resume() of a run that newer thread work superseded. */
export class SupersededExecutionRunError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(
      `Thread execution run ${runId} was superseded by newer thread work and was cancelled.`
    );
    this.name = "SupersededExecutionRunError";
    this.runId = runId;
  }
}

async function cancelSupersededExecutionRun(
  context: AgentThreadContext,
  executionRun: QueuedThreadExecutionRun
): Promise<void> {
  const turns = context.execution.executionHost?.store.turns;
  if (!turns?.listByThreadKey) {
    return;
  }
  const latestRun = latestRecoverableRun(
    context,
    await turns.listByThreadKey(context.threadKey)
  );
  if (!latestRun || latestRun.runId === executionRun.runId) {
    return;
  }
  await supersedeExecutionRun(turns, executionRun);
}

async function executionRunHasPendingInput(
  context: AgentThreadContext,
  executionRun: QueuedThreadExecutionRun
): Promise<boolean> {
  const prefix = createThreadExecutionRunId({
    threadKey: context.threadKey,
    turnId: "",
  });
  if (!executionRun.runId.startsWith(prefix)) {
    return false;
  }
  let messageId: string;
  try {
    messageId = decodeURIComponent(executionRun.runId.slice(prefix.length));
  } catch {
    return false;
  }
  if (!messageId) {
    return false;
  }
  const executionHost = context.execution.executionHost;
  const own = await claimDurableThreadInput({
    boundary: "turn-idle",
    executionHost,
    messageId,
    threadKey: context.threadKey,
  });
  if (own.kind !== "claimed" || !own.record) {
    return false;
  }
  await releaseDurableThreadInputClaim({ executionHost, record: own.record });
  return true;
}

async function supersedeExecutionRun(
  turns: TurnStore,
  executionRun: QueuedThreadExecutionRun
): Promise<never> {
  const cancelled = await transitionTurn(turns, {
    expected: { leaseId: executionRun.leaseId ?? null, status: "leased" },
    runId: executionRun.runId,
    update: { lease: null, status: "cancelled" },
  });
  if (!cancelled.ok) {
    throw new TurnTransitionConflictError(
      executionRun.runId,
      "cancel",
      cancelled.reason
    );
  }
  throw new SupersededExecutionRunError(executionRun.runId);
}

function latestRecoverableRun(
  context: AgentThreadContext,
  runs: readonly TurnRecord[]
): TurnRecord | undefined {
  const ownerNamespace = context.execution.ownerNamespace ?? "";
  const hasExplicitNamespace = context.execution.ownerNamespace !== undefined;
  return runs
    .filter(
      (run) =>
        (run.kind === "user-turn" || run.kind === "tool-recovery") &&
        isRecordClaimableByAgent(run, ownerNamespace, hasExplicitNamespace)
    )
    .at(-1);
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
  const runs = await turns.listByThreadKey(context.threadKey);
  signal.throwIfAborted();
  const latestRun = latestRecoverableRun(context, runs);
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
  // Only a recoverable run can collide with this host's active drain; settled
  // history must not report busy while a finished drain is winding down.
  if (isThreadDrainOwned(host, context.threadKey)) {
    throw busyError();
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
  const inMemoryContinuation = context.state.continuationCheckpoint();
  if (inMemoryContinuation?.recover) {
    // Mirror input admission: a throwing recovery fences every route, and a
    // resolvable one is this process's newer view of the run. Never replace
    // it with the persisted checkpoint.
    const recovered = inMemoryContinuation.recover();
    if (context.state.isContinuationCurrent(inMemoryContinuation)) {
      inMemoryContinuation.history.splice(
        0,
        inMemoryContinuation.history.length,
        ...recovered
      );
      return enqueuePreparedTurn(
        context,
        { continuation: inMemoryContinuation },
        executionRun
      );
    }
  }
  const committedHistory = context.state.modelSnapshot();
  const committedVersion =
    context.state.threadCheckpointReference().threadVersion;
  const turns = context.execution.executionHost?.store.turns;
  // Provider tool call ids can recur across steps and turns, so a result
  // counts as committed only when the thread was committed after its
  // checkpoint. Step-end commits include the step's results, but a
  // background compaction can commit mid-step, so the id must also appear.
  const unrestorable = priorCompletedToolCalls(checkpoint).filter(
    (call) =>
      call.threadVersion === undefined ||
      call.threadVersion === committedVersion ||
      !historyHasToolResult(committedHistory, call.toolCallId)
  );
  const [firstUnrestorable, ...restUnrestorable] = unrestorable;
  if (firstUnrestorable) {
    // Only the latest tool checkpoint can be restored; resuming without an
    // earlier completed result would let the model repeat its effects.
    if (turns) {
      await transitionTurn(turns, {
        expected: { leaseId: executionRun.leaseId ?? null, status: "leased" },
        runId: executionRun.runId,
        update: { lease: null, status: "needs-recovery" },
      });
    }
    throw new UnrestorableToolResultsError(executionRun.runId, [
      firstUnrestorable,
      ...restUnrestorable,
    ]);
  }
  const history = buildRecoveredContinuationHistory(
    committedHistory,
    committedVersion,
    checkpoint
  );
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
      await releaseClaimedContinuationRun(
        turns,
        { runId: executionRun.runId, status: "leased" },
        executionRun.leaseId
      );
    }
    return;
  }
  return enqueuePreparedTurn(context, { continuation }, executionRun);
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
  return await loadCheckedCheckpoint(host, record.runId, signal, async () => {
    await transitionTurn(host.store.turns, {
      expected: { leaseId, status: record.status },
      runId: record.runId,
      update: { lease: null, status: "needs-recovery" },
    });
  });
}

export async function throwIfManualToolRecovery(
  host: AgentHost,
  runId: string,
  throwGeneric = false,
  signal?: AbortSignal
): Promise<void> {
  await loadCheckedCheckpoint(host, runId, signal);
  if (throwGeneric) {
    throw new Error(
      `Thread execution run ${runId} requires manual recovery before continuing.`
    );
  }
}

async function loadCheckedCheckpoint(
  host: AgentHost,
  runId: string,
  signal?: AbortSignal,
  onManualRecovery?: () => Promise<void>
): Promise<Checkpoint | null> {
  const latest = await host.store.checkpoints.latest(runId);
  signal?.throwIfAborted();
  const unrecoverableTool = manualRecoveryToolCheckpoint(latest);
  if (unrecoverableTool) {
    await onManualRecovery?.();
    throw new ToolExecutionNeedsRecoveryError(unrecoverableTool);
  }
  return latest;
}

export async function releaseClaimedContinuationRun(
  turns: TurnStore,
  record: Pick<TurnRecord, "runId" | "status">,
  leaseId: string | null
): Promise<void> {
  const transition = await transitionTurn(turns, {
    expected: { leaseId, status: record.status },
    runId: record.runId,
    update: { lease: null, status: "queued" },
  });
  if (!transition.ok) {
    throw new TurnTransitionConflictError(
      record.runId,
      "requeue",
      transition.reason
    );
  }
}

function historyHasToolResult(
  history: readonly ModelMessage[],
  toolCallId: string
): boolean {
  return history.some(
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
}

/**
 * Parks a crashed run whose earlier completed tool results never reached
 * committed history. It is a needs-recovery error so callers never requeue.
 */
class UnrestorableToolResultsError extends ToolExecutionNeedsRecoveryError {
  readonly runId: string;
  readonly toolCalls: readonly CompletedToolCall[];

  constructor(
    runId: string,
    toolCalls: readonly [CompletedToolCall, ...CompletedToolCall[]]
  ) {
    const [first] = toolCalls;
    super({
      attempt: 1,
      idempotencyKey: `${runId}:${first.toolCallId}`,
      policy: "manual-recovery",
      toolCallId: first.toolCallId,
      toolName: first.toolName,
    });
    this.message = `Thread execution run ${runId} requires manual recovery: completed tool calls ${toolCalls
      .map((call) => `${call.toolName} (${call.toolCallId})`)
      .join(
        ", "
      )} are missing from committed thread history and cannot be restored.`;
    this.runId = runId;
    this.toolCalls = toolCalls;
  }
}

function buildRecoveredContinuationHistory(
  baseHistory: readonly ModelMessage[],
  committedVersion: string | null,
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
  // Unchanged thread version: nothing committed the result, even if an older
  // call reused its id. Otherwise the id shows whether the commit included it.
  const resultVersion = recordedThreadVersion(checkpoint);
  if (
    (resultVersion === undefined || resultVersion !== committedVersion) &&
    historyHasToolResult(history, toolCallId)
  ) {
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
  const candidate =
    checkpoint?.phase === "before-tool"
      ? (checkpoint.pendingToolCall as Record<string, unknown> | undefined)
      : undefined;
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
