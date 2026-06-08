import type { AgentEvent } from "./session/events";
import type { RuntimeInputSink, SubagentJob } from "./subagent-types";

export function emitBackgroundJobUpdate(
  parentSession: RuntimeInputSink,
  job: SubagentJob,
  event: AgentEvent
): Promise<void> {
  if (!isParentVisibleJobUpdate(event)) {
    return Promise.resolve();
  }

  return parentSession.emitObserverEvent({
    eventType: event.type,
    delegateToolCallId: job.delegateToolCallId,
    status: job.status,
    subagent: job.subagent,
    task_id: job.id,
    type: "subagent-job-update" as const,
  });
}

function isParentVisibleJobUpdate(event: AgentEvent): boolean {
  return (
    event.type === "assistant-text" ||
    event.type === "tool-call" ||
    event.type === "tool-result" ||
    event.type === "turn-abort" ||
    event.type === "turn-error"
  );
}
