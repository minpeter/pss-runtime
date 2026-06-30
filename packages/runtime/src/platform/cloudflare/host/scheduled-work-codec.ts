import type { CloudflareScheduledThreadPrompt } from "./scheduled-work-queue";
import type { ScheduledWorkRow } from "./scheduled-work-table";

export function runScheduledWorkId(runId: string): string {
  return runId;
}

export function threadPromptScheduledWorkId(
  prompt: CloudflareScheduledThreadPrompt
): string {
  return [prompt.threadKey, prompt.idempotencyKey ?? "", prompt.runId ?? ""]
    .map(scheduledWorkIdPart)
    .join("|");
}

export function isLegacyRunWork(row: ScheduledWorkRow): boolean {
  const runId = parseScheduledRunPayload(row.payload);
  return runId !== undefined && row.work_id === runScheduledWorkId(runId);
}

export function isLegacyThreadPromptWork(row: ScheduledWorkRow): boolean {
  const prompt = parseScheduledThreadPromptPayload(row.payload);
  return (
    prompt !== undefined && row.work_id === threadPromptScheduledWorkId(prompt)
  );
}

export function parseScheduledRunPayload(payload: string): string | undefined {
  const value: unknown = JSON.parse(payload);
  return typeof value === "string" ? value : undefined;
}

export function parseScheduledThreadPromptPayload(
  payload: string
): CloudflareScheduledThreadPrompt | undefined {
  const value: unknown = JSON.parse(payload);
  return isScheduledThreadPrompt(value) ? value : undefined;
}

export function isScheduledThreadPrompt(
  value: unknown
): value is CloudflareScheduledThreadPrompt {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("threadKey" in value) || typeof value.threadKey !== "string") {
    return false;
  }
  if ("idempotencyKey" in value && typeof value.idempotencyKey !== "string") {
    return false;
  }
  if ("notificationId" in value && typeof value.notificationId !== "string") {
    return false;
  }
  if ("runId" in value && typeof value.runId !== "string") {
    return false;
  }
  return true;
}

export function applyListLimit<T>(
  values: readonly T[],
  limit: number | undefined
): T[] {
  if (limit === undefined) {
    return [...values];
  }
  return values.slice(0, Math.max(0, Math.floor(limit)));
}

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function scheduledWorkIdPart(value: string): string {
  return `${value.length}:${value}`;
}
