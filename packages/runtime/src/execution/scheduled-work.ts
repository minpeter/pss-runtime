/**
 * Platform-neutral scheduled-work semantics shared by every platform adapter.
 *
 * Adapters own how scheduled work is stored (JSON files, Durable Object
 * SQLite, in-memory maps) but must agree on what a work item means: how work
 * ids are derived, what a scheduled thread prompt looks like, and how list
 * limits behave. Keeping these here prevents the adapters from drifting apart.
 */

export type ScheduledWorkKind = "run" | "thread-prompt";

export interface ScheduledThreadPrompt {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly runId?: string;
  readonly threadKey: string;
}

export function isScheduledThreadPrompt(
  value: unknown
): value is ScheduledThreadPrompt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.threadKey === "string" &&
    isOptionalString(record.idempotencyKey) &&
    isOptionalString(record.notificationId) &&
    isOptionalString(record.runId)
  );
}

// Length-prefixing keeps ids built from multiple parts unambiguous even when
// a part contains the separator character.
export function scheduledWorkIdPart(value: string): string {
  return `${value.length}:${value}`;
}

export function threadPromptScheduledWorkId(
  prompt: ScheduledThreadPrompt
): string {
  return [prompt.threadKey, prompt.idempotencyKey ?? "", prompt.runId ?? ""]
    .map(scheduledWorkIdPart)
    .join("|");
}

export function normalizedListLimit(
  limit: number | undefined
): number | undefined {
  return limit === undefined ? undefined : Math.max(0, Math.floor(limit));
}

export function applyListLimit<T>(
  values: readonly T[],
  limit: number | undefined
): T[] {
  const normalized = normalizedListLimit(limit);
  return normalized === undefined ? [...values] : values.slice(0, normalized);
}

export function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
