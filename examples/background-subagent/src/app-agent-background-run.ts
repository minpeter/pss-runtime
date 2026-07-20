import type { Agent, AgentTurn } from "@minpeter/pss-runtime";
import type { AgentHost, TurnRecord } from "@minpeter/pss-runtime/execution";
import {
  collectAssistantOutput,
  collectRunEvents,
  replayRun,
} from "./app-agent-events";
import { enqueueCompletionNotification } from "./app-agent-notification";
import { readDurableBackgroundDelegationState } from "./background-delegation";
import { readerChildName } from "./delegate-tool";

export async function resumeBackgroundDelegation({
  host,
  ownerNamespace,
  parentThreadKey,
  reader,
  run,
}: {
  readonly host: AgentHost;
  readonly ownerNamespace: string;
  readonly parentThreadKey: string;
  readonly reader: Agent;
  readonly run: TurnRecord;
}): Promise<AgentTurn | null> {
  if (run.status === "completed") {
    return null;
  }

  const checkpoint = await host.store.checkpoints.latest(run.runId);
  const state = readDurableBackgroundDelegationState(checkpoint);
  if (!state) {
    throw new Error(`Background task ${run.runId} is missing app state.`);
  }
  assertOwnedBackgroundRun({ ownerNamespace, parentThreadKey, run, state });

  await host.store.turns.update({ ...run, status: "running" });
  const childRun = await reader.thread(run.threadKey).send(state.prompt);
  const events = await collectRunEvents(childRun);
  const output = {
    result: "completed",
    subagent: readerChildName,
    text: collectAssistantOutput(events),
  };
  await host.store.turns.update({
    ...run,
    checkpointVersion: run.checkpointVersion,
    output,
    status: "completed",
  });
  await enqueueCompletionNotification({
    host,
    run,
    state,
  });

  return replayRun(events);
}

function assertOwnedBackgroundRun({
  ownerNamespace,
  parentThreadKey,
  run,
  state,
}: {
  readonly ownerNamespace: string;
  readonly parentThreadKey: string;
  readonly run: TurnRecord;
  readonly state: NonNullable<
    ReturnType<typeof readDurableBackgroundDelegationState>
  >;
}): void {
  if (run.ownerNamespace !== ownerNamespace) {
    throw new Error(`Background task ${run.runId} is not owned by this app.`);
  }

  if (state.parentThreadKey !== parentThreadKey) {
    throw new Error(
      `Background task ${run.runId} is not linked to this thread.`
    );
  }

  if (state.subagent !== readerChildName) {
    throw new Error(`Background task ${run.runId} has an unknown worker.`);
  }
}
