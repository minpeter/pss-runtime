import {
  isScheduledThreadPrompt,
  threadPromptScheduledWorkId,
} from "../../../execution/scheduled-work";
import type { ScheduledWorkRow } from "../storage/sqlite/scheduled-work-table";
import type { CloudflareScheduledThreadPrompt } from "./scheduled-work-queue";

export function runScheduledWorkId(runId: string): string {
  return runId;
}

// Canonical = the row's work_id round-trips the alarm scheduler's id
// derivation for its payload. Rows in any other format (e.g. written by a
// different scheduler into the shared kind) must not be listed or drained
// here: deleting them under the canonical id would miss, so claiming them
// would redeliver forever.
export function isCanonicalRunWork(row: ScheduledWorkRow): boolean {
  const runId = parseScheduledRunPayload(row.payload);
  return runId !== undefined && row.work_id === runScheduledWorkId(runId);
}

export function isCanonicalThreadPromptWork(row: ScheduledWorkRow): boolean {
  const prompt = parseScheduledThreadPromptPayload(row.payload);
  return (
    prompt !== undefined && row.work_id === threadPromptScheduledWorkId(prompt)
  );
}

export function parseScheduledRunPayload(payload: string): string | undefined {
  const value = parseJson(payload);
  return typeof value === "string" ? value : undefined;
}

export function parseScheduledThreadPromptPayload(
  payload: string
): CloudflareScheduledThreadPrompt | undefined {
  const value = parseJson(payload);
  return isScheduledThreadPrompt(value) ? value : undefined;
}

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return;
  }
}
