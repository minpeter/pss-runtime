import type { Checkpoint } from "../../execution/host/types";
import { createRuntimeInputState } from "../input/runtime-input";
import {
  type AgentTurn,
  BufferedAgentTurn,
  bindTurnExecutionRun,
  type ThreadContinuationOptions,
} from "../protocol/turn";
import { waitForCompactionQueue } from "../runtime/compaction-queue-deadline";
import {
  buildRecoveredContinuationHistory,
  recoverPersistedThreadContinuation,
} from "../runtime/durable-continuation-recovery";
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
    throw Object.assign(new Error("Thread has active or queued work."), {
      code: "THREAD_CONTINUATION_BUSY",
    });
  }
  const inMemoryContinuation = context.state.continuationCheckpoint();
  if (!inMemoryContinuation) {
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
      throw Object.assign(new Error("Thread has queued durable work."), {
        code: "THREAD_CONTINUATION_BUSY",
      });
    }
    assertAgentThreadOpen(context);
    signal.throwIfAborted();
    const recovered = await recoverPersistedThreadContinuation({
      executionHost: host,
      signal,
      state: context.state,
      threadKey: context.threadKey,
    });
    assertAgentThreadOpen(context);
    signal.throwIfAborted();
    if (!recovered) {
      return;
    }
    const recoveredRun = new BufferedAgentTurn();
    bindTurnExecutionRun(
      recoveredRun,
      recovered.executionRun.runId,
      recovered.executionRun.leaseId ?? null
    );
    context.inputQueue.push({
      continuation: recovered.continuation,
      executionRun: recovered.executionRun,
      initialEvents: [],
      preUserRuntimeInputs: [],
      run: recoveredRun,
      runtimeInput: createRuntimeInputState([]),
    });
    startThreadQueueDrain(recoveredRun, () =>
      drainAgentThreadInputQueue(context)
    );
    return recoveredRun;
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
  const run = new BufferedAgentTurn();
  if (precreated) {
    bindTurnExecutionRun(run, precreated.runId);
  }
  context.inputQueue.push({
    continuation: inMemoryContinuation,
    ...(precreated
      ? {
          executionRun: {
            kind: precreated.kind,
            runId: precreated.runId,
          },
        }
      : {}),
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
  assertAgentThreadOpen(context);
  await ensureAgentThreadStarted(context);
  assertAgentThreadOpen(context);
  await context.state.refresh();
  assertAgentThreadOpen(context);
  const history = buildRecoveredContinuationHistory(
    context.state.modelSnapshot(),
    checkpoint
  );
  context.state.setContinuationCheckpoint(history);
  const continuation = context.state.continuationCheckpoint();
  if (!continuation) {
    throw new Error("Thread continuation checkpoint was revoked.");
  }
  const run = new BufferedAgentTurn();
  bindTurnExecutionRun(run, executionRun.runId, executionRun.leaseId ?? null);
  context.inputQueue.push({
    continuation,
    executionRun,
    initialEvents: [],
    preUserRuntimeInputs: [],
    run,
    runtimeInput: createRuntimeInputState([]),
  });
  startThreadQueueDrain(run, () => drainAgentThreadInputQueue(context));
  return run;
}
