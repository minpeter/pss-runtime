import type { CloudflareAlarmDrainBudget } from "@minpeter/pss-runtime/cloudflare";

export const alarmDrainBudget = {
  continuationRunAfterMs: 0,
  deadlineMs: 30_000,
  failureRunAfterMs: 1000,
  maxEvents: 64,
  maxRuns: 6,
  maxSessionPrompts: 6,
} satisfies CloudflareAlarmDrainBudget;

export const workerStorePrefix = "agent-worker-demo";
