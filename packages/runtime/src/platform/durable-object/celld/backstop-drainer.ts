import { runTurnBackstop } from "../../../execution/dispatch/turn-backstop";
import type {
  CelldScheduledWorkDrainOptions,
  CelldScheduledWorkRunContext,
} from "./drainer";
import {
  decrement,
  listOptions,
  type MutableDrainResult,
  workOptions,
} from "./drainer-support";
import { listCelldScheduledBackstops } from "./scheduler";
import {
  ackCelldScheduledBackstop,
  claimCelldScheduledBackstop,
  retryCelldScheduledBackstop,
} from "./scheduler-claims";

const BACKSTOP_ERROR_RETRY_MS = 1000;

/**
 * Hands each due backstop to `runTurnBackstop()`: a settled run's backstop is
 * acknowledged, a live owner's is moved past its lease, and a resumed run is
 * drained. The resumed run's start replaced the claimed backstop with its
 * own, which its settlement cancels.
 */
export async function drainCelldBackstops(
  options: CelldScheduledWorkDrainOptions,
  result: MutableDrainResult
): Promise<void> {
  const { agentForRun, onEvent, storage } = options;
  for (const backstop of await listCelldScheduledBackstops(
    storage,
    listOptions(options, result.remaining)
  )) {
    const { runId } = backstop;
    const context: CelldScheduledWorkRunContext = {
      kind: "backstop",
      runId,
      threadKey: backstop.threadKey,
    };
    const claimToken = await claimCelldScheduledBackstop(
      storage,
      runId,
      workOptions(options)
    );
    if (claimToken === undefined) {
      result.remaining = decrement(result.remaining);
      continue;
    }
    try {
      const outcome = await runTurnBackstop(await agentForRun(context), runId, {
        ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
      });
      if (outcome.action === "retry") {
        await retryCelldScheduledBackstop(storage, runId, outcome.runAfterMs, {
          ...workOptions(options),
          claimToken,
        });
        result.skippedBackstops.push(runId);
      } else if (outcome.action === "done") {
        await ackCelldScheduledBackstop(storage, runId, {
          ...workOptions(options),
          claimToken,
          rearm: false,
        });
        result.ackedBackstops.push(runId);
      } else {
        for await (const event of outcome.turn.events()) {
          result.events.push(event);
          await onEvent?.(context, event);
        }
        result.ackedBackstops.push(runId);
      }
    } catch (error) {
      try {
        await retryCelldScheduledBackstop(
          storage,
          runId,
          BACKSTOP_ERROR_RETRY_MS,
          { ...workOptions(options), claimToken }
        );
      } catch {
        throw error;
      }
      throw error;
    }
    result.remaining = decrement(result.remaining);
  }
}
