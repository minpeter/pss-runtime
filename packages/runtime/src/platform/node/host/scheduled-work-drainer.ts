import type { Agent } from "../../../agent/core/agent";
import { executionHost } from "../../../execution/host/host";
import type { RunStatus } from "../../../execution/host/types";
import type { AgentEvent } from "../../../thread/protocol/events";
import { decrementLimit, normalizedListLimit } from "./scheduled-work-codec";
import {
  ackScheduledNodeRun,
  ackScheduledNodeThreadPrompt,
  listScheduledNodeRuns,
  listScheduledNodeThreadPrompts,
} from "./scheduled-work-store";
import type {
  NodeScheduledThreadPrompt,
  NodeScheduledWorkDrainOptions,
  NodeScheduledWorkDrainResult,
  NodeScheduledWorkRunContext,
} from "./scheduled-work-types";

export async function drainScheduledNodeWork({
  agentForRun,
  directory,
  limit,
  nowMs,
  onEvent,
}: NodeScheduledWorkDrainOptions): Promise<NodeScheduledWorkDrainResult> {
  const events: AgentEvent[] = [];
  const ackedRuns: string[] = [];
  const ackedThreadPrompts: NodeScheduledThreadPrompt[] = [];
  const skippedRuns: string[] = [];
  const skippedThreadPrompts: NodeScheduledThreadPrompt[] = [];
  const remaining = { value: normalizedListLimit(limit) };

  for (const runId of await listScheduledNodeRuns(directory, {
    limit: remaining.value,
    nowMs,
  })) {
    const context = { kind: "run", runId } as const;
    if (
      await resumeAndDrainScheduledNodeWork({
        agentForRun,
        context,
        events,
        onEvent,
      })
    ) {
      await ackScheduledNodeRun(directory, runId);
      ackedRuns.push(runId);
    } else {
      skippedRuns.push(runId);
    }
    decrementLimit(remaining);
  }

  if (remaining.value === 0) {
    return {
      ackedRuns,
      ackedThreadPrompts,
      events,
      skippedRuns,
      skippedThreadPrompts,
    };
  }

  for (const prompt of await listScheduledNodeThreadPrompts(directory, {
    limit: remaining.value,
    nowMs,
  })) {
    if (!prompt.runId) {
      await ackScheduledNodeThreadPrompt(directory, prompt);
      ackedThreadPrompts.push(prompt);
      decrementLimit(remaining);
      continue;
    }
    const context = {
      idempotencyKey: prompt.idempotencyKey,
      kind: "thread-prompt",
      notificationId: prompt.notificationId,
      runId: prompt.runId,
      threadKey: prompt.threadKey,
    } as const;
    if (
      await resumeAndDrainScheduledNodeWork({
        agentForRun,
        context,
        events,
        onEvent,
      })
    ) {
      await ackScheduledNodeThreadPrompt(directory, prompt);
      ackedThreadPrompts.push(prompt);
    } else {
      skippedThreadPrompts.push(prompt);
    }
    decrementLimit(remaining);
  }

  return {
    ackedRuns,
    ackedThreadPrompts,
    events,
    skippedRuns,
    skippedThreadPrompts,
  };
}

async function resumeAndDrainScheduledNodeWork({
  agentForRun,
  context,
  events,
  onEvent,
}: {
  readonly agentForRun: (
    context: NodeScheduledWorkRunContext
  ) => Agent | Promise<Agent>;
  readonly context: NodeScheduledWorkRunContext;
  readonly events: AgentEvent[];
  readonly onEvent?: (
    context: NodeScheduledWorkRunContext,
    event: AgentEvent
  ) => void;
}): Promise<boolean> {
  const agent = await agentForRun(context);
  const run = await agent.resume(context.runId);
  if (!run) {
    return await shouldAckNullResume(agent, context.runId);
  }
  for await (const event of run.events()) {
    events.push(event);
    onEvent?.(context, event);
  }
  return true;
}

async function shouldAckNullResume(
  agent: Agent,
  runId: string
): Promise<boolean> {
  const host = executionHost(agent.host);
  if (!host) {
    return false;
  }
  const record = await host.store.runs.get(runId);
  if (!record) {
    return true;
  }
  return isTerminalRunStatus(record.status);
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "cancelled" || status === "completed" || status === "error";
}
