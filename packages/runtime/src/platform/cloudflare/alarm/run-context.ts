import type { AgentEvent } from "../../../thread/protocol/events";
import type { AgentTurn } from "../../../thread/protocol/turn";

export interface CloudflareAlarmAgent {
  resume(runId: string): Promise<AgentTurn | null>;
}

export type CloudflareAlarmRunSource = "scheduled-run" | "thread-prompt";

export interface CloudflareAlarmRunContext {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly runId: string;
  readonly source: CloudflareAlarmRunSource;
  readonly threadKey: string;
}

export type CloudflareAlarmAgentForRun = (
  context: CloudflareAlarmRunContext
) => CloudflareAlarmAgent | Promise<CloudflareAlarmAgent>;

export type CloudflareAlarmEventHandler = (
  context: CloudflareAlarmRunContext,
  event: AgentEvent
) => Promise<void> | void;
