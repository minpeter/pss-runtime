import type { ScheduledWorkKind } from "../host/scheduled-work-table";

export const agentsRunKind = "agents-run" satisfies ScheduledWorkKind;
export const agentsThreadPromptKind =
  "agents-thread-prompt" satisfies ScheduledWorkKind;
export const legacyRunKind = "run" satisfies ScheduledWorkKind;
export const legacyThreadPromptKind =
  "thread-prompt" satisfies ScheduledWorkKind;
