import type {
  NotificationRecord,
  RunCheckpoint,
  RunKind,
  RunLease,
  RunRecord,
  RunStatus,
  StoredAgentEvent,
} from "../../../../execution/host/types";
import type { AgentEvent, UserInput } from "../../../../thread/protocol/events";
import { isRecord } from "./utils";

export function parseRunRecord(value: unknown, file: string): RunRecord {
  if (!isRecord(value)) {
    throw invalidFile(file, "expected run object");
  }
  if (
    typeof value.checkpointVersion !== "number" ||
    !isRunKind(value.kind) ||
    typeof value.rootRunId !== "string" ||
    typeof value.runId !== "string" ||
    !isRunStatus(value.status) ||
    typeof value.threadKey !== "string"
  ) {
    throw invalidFile(file, "expected run record fields");
  }

  return {
    checkpointVersion: value.checkpointVersion,
    ...(typeof value.dedupeKey === "string"
      ? { dedupeKey: value.dedupeKey }
      : {}),
    kind: value.kind,
    ...(isRunLease(value.lease) ? { lease: value.lease } : {}),
    ...("output" in value ? { output: value.output } : {}),
    ...(typeof value.ownerNamespace === "string"
      ? { ownerNamespace: value.ownerNamespace }
      : {}),
    ...(typeof value.parentRunId === "string"
      ? { parentRunId: value.parentRunId }
      : {}),
    ...(typeof value.publicTaskId === "string"
      ? { publicTaskId: value.publicTaskId }
      : {}),
    rootRunId: value.rootRunId,
    runId: value.runId,
    status: value.status,
    threadKey: value.threadKey,
  };
}

export function parseRunCheckpoint(
  value: unknown,
  file: string
): RunCheckpoint {
  if (!isRecord(value)) {
    throw invalidFile(file, "expected checkpoint object");
  }
  if (
    typeof value.checkpointId !== "string" ||
    !isCheckpointPhase(value.phase) ||
    typeof value.runId !== "string" ||
    typeof value.version !== "number"
  ) {
    throw invalidFile(file, "expected checkpoint fields");
  }

  return {
    ...(typeof value.childRunId === "string"
      ? { childRunId: value.childRunId }
      : {}),
    checkpointId: value.checkpointId,
    ...("pendingToolCall" in value
      ? { pendingToolCall: value.pendingToolCall }
      : {}),
    phase: value.phase,
    runId: value.runId,
    runtimeState: value.runtimeState,
    threadSnapshot: value.threadSnapshot,
    version: value.version,
  };
}

export function parseNotificationRecord(
  value: unknown,
  file: string
): NotificationRecord {
  if (!isRecord(value)) {
    throw invalidFile(file, "expected notification object");
  }
  if (
    typeof value.idempotencyKey !== "string" ||
    !isUserInput(value.input) ||
    typeof value.notificationId !== "string" ||
    typeof value.runId !== "string" ||
    !isNotificationStatus(value.status) ||
    typeof value.threadKey !== "string"
  ) {
    throw invalidFile(file, "expected notification fields");
  }

  const observerEvents = Array.isArray(value.observerEvents)
    ? value.observerEvents.filter(isAgentEvent)
    : undefined;
  if (
    Array.isArray(value.observerEvents) &&
    observerEvents?.length !== value.observerEvents.length
  ) {
    throw invalidFile(file, "expected agent observer events");
  }

  return {
    idempotencyKey: value.idempotencyKey,
    input: value.input,
    notificationId: value.notificationId,
    ...(observerEvents ? { observerEvents } : {}),
    ...(typeof value.ownerNamespace === "string"
      ? { ownerNamespace: value.ownerNamespace }
      : {}),
    runId: value.runId,
    status: value.status,
    threadKey: value.threadKey,
  };
}

export function parseEventLogLine(
  line: string,
  file: string
): StoredAgentEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Invalid FileExecutionStore event log ${JSON.stringify(
          file
        )}: invalid JSON (${error.message})`
      );
    }
    throw error;
  }

  if (
    !(isRecord(parsed) && isRecord(parsed.cursor)) ||
    typeof parsed.cursor.offset !== "number" ||
    !isAgentEvent(parsed.event) ||
    typeof parsed.runId !== "string"
  ) {
    throw invalidEventLog(file, "expected stored agent event");
  }

  return {
    cursor: { offset: parsed.cursor.offset },
    event: parsed.event,
    runId: parsed.runId,
  };
}

export function isClaimable(record: RunRecord): boolean {
  return (
    record.status === "leased" ||
    record.status === "needs-recovery" ||
    record.status === "queued" ||
    record.status === "running" ||
    record.status === "suspended"
  );
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return isRecord(value) && typeof value.type === "string";
}

function isUserInput(value: unknown): value is UserInput {
  return (
    isRecord(value) &&
    ((value.type === "user-text" &&
      (typeof value.text === "string" || isStringArray(value.text))) ||
      (value.type === "user-message" && Array.isArray(value.content)))
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isRunLease(value: unknown): value is RunLease {
  return (
    isRecord(value) &&
    typeof value.attempt === "number" &&
    typeof value.leaseId === "string" &&
    typeof value.leaseUntilMs === "number"
  );
}

function isRunKind(value: unknown): value is RunKind {
  return (
    value === "notification" ||
    value === "tool-recovery" ||
    value === "user-turn"
  );
}

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "cancelled" ||
    value === "completed" ||
    value === "error" ||
    value === "leased" ||
    value === "needs-recovery" ||
    value === "queued" ||
    value === "running" ||
    value === "suspended"
  );
}

function isCheckpointPhase(value: unknown): value is RunCheckpoint["phase"] {
  return (
    value === "after-model" ||
    value === "after-notification" ||
    value === "after-tool" ||
    value === "before-child-run" ||
    value === "before-model" ||
    value === "before-notification" ||
    value === "before-tool" ||
    value === "child-linked" ||
    value === "suspended"
  );
}

function isNotificationStatus(
  value: unknown
): value is NotificationRecord["status"] {
  return value === "acked" || value === "cancelled" || value === "pending";
}

function invalidFile(file: string, message: string): Error {
  return new Error(
    `Invalid FileExecutionStore file ${JSON.stringify(file)}: ${message}`
  );
}

function invalidEventLog(file: string, message: string): Error {
  return new Error(
    `Invalid FileExecutionStore event log ${JSON.stringify(file)}: ${message}`
  );
}
