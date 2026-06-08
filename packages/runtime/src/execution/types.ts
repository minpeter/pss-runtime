import type { AgentEvent, UserInput } from "../session/events";
import type { SessionStore } from "../session/store/types";
import type { DurableBackgroundHost, SessionHost } from "./capabilities";

export type AgentHost = DurableBackgroundHost | ExecutionHost | SessionHost;

export interface ExecutionHost {
  readonly capabilities: AgentHostCapabilities;
  readonly scheduler: ExecutionScheduler;
  readonly store: ExecutionStore;
}

export interface AgentHostCapabilities {
  readonly backgroundSubagents?: "durable" | "in-process";
}

export interface ExecutionScheduler {
  enqueueRun(
    runId: string,
    options?: { readonly runAfterMs?: number }
  ): Promise<void>;
  resumeSession(
    sessionKey: string,
    options: ResumeSessionOptions
  ): Promise<void>;
}

export interface ResumeSessionOptions {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly runId: string;
}

export type RunKind =
  | "background-subagent"
  | "notification"
  | "subagent"
  | "tool-recovery"
  | "user-turn";

export type RunStatus =
  | "cancelled"
  | "completed"
  | "error"
  | "leased"
  | "needs-recovery"
  | "queued"
  | "running"
  | "suspended";

export interface RunLease {
  readonly attempt: number;
  readonly leaseId: string;
  readonly leaseUntilMs: number;
}

export interface RunRecord {
  readonly checkpointVersion: number;
  readonly dedupeKey?: string;
  readonly kind: RunKind;
  readonly lease?: RunLease;
  readonly output?: unknown;
  readonly ownerNamespace?: string;
  readonly parentRunId?: string;
  readonly publicTaskId?: string;
  readonly rootRunId: string;
  readonly runId: string;
  readonly sessionKey: string;
  readonly status: RunStatus;
}

export type ClaimRunResult =
  | { readonly lease: RunLease; readonly ok: true; readonly record: RunRecord }
  | {
      readonly ok: false;
      readonly reason: "leased" | "not-claimable" | "not-found";
    };

export interface ClaimRunOptions {
  readonly attempt: number;
  readonly leaseId: string;
  readonly leaseMs: number;
  readonly nowMs: number;
}

export type CheckpointPhase =
  | "after-model"
  | "after-notification"
  | "after-tool"
  | "before-child-run"
  | "before-model"
  | "before-notification"
  | "before-tool"
  | "child-linked"
  | "suspended";

export interface RunCheckpoint {
  readonly checkpointId: string;
  readonly childRunId?: string;
  readonly pendingToolCall?: unknown;
  readonly phase: CheckpointPhase;
  readonly runId: string;
  readonly runtimeState: unknown;
  readonly sessionSnapshot: unknown;
  readonly version: number;
}

export type CheckpointWriteResult =
  | { readonly ok: true; readonly version: number }
  | {
      readonly currentVersion: number;
      readonly ok: false;
      readonly reason: "stale-version";
    };

export interface EventCursor {
  readonly offset: number;
}

export interface StoredAgentEvent {
  readonly cursor: EventCursor;
  readonly event: AgentEvent;
  readonly runId: string;
}

export type NotificationStatus = "acked" | "cancelled" | "pending";

export interface NotificationRecord {
  readonly idempotencyKey: string;
  readonly input: UserInput;
  readonly notificationId: string;
  readonly observerEvents?: readonly AgentEvent[];
  readonly ownerNamespace?: string;
  readonly runId: string;
  readonly sessionKey: string;
  readonly status: NotificationStatus;
}

export type NotificationWriteResult =
  | { readonly ok: true }
  | {
      readonly existingNotificationId: string;
      readonly ok: false;
      readonly reason: "duplicate";
    };

export type NotificationClaimResult =
  | { readonly ok: true; readonly record: NotificationRecord }
  | {
      readonly ok: false;
      readonly reason: "already-claimed" | "not-found";
      readonly record?: NotificationRecord;
    };

export interface RunStore {
  claim(runId: string, options: ClaimRunOptions): Promise<ClaimRunResult>;
  create(record: RunRecord): Promise<RunRecord>;
  get(runId: string): Promise<RunRecord | null>;
  getByDedupeKey(dedupeKey: string): Promise<RunRecord | null>;
  listByParentRunId(parentRunId: string): Promise<readonly RunRecord[]>;
  update(record: RunRecord): Promise<RunRecord>;
}

export interface CheckpointStore {
  append(
    checkpoint: RunCheckpoint,
    options: { readonly expectedVersion: number }
  ): Promise<CheckpointWriteResult>;
  latest(runId: string): Promise<RunCheckpoint | null>;
}

export interface EventStore {
  append(runId: string, event: AgentEvent): Promise<EventCursor>;
  read(runId: string, cursor?: EventCursor): AsyncIterable<StoredAgentEvent>;
}

export interface NotificationInbox {
  claimByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationClaimResult>;
  enqueue(record: NotificationRecord): Promise<NotificationWriteResult>;
  getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationRecord | null>;
  releaseByIdempotencyKey(idempotencyKey: string): Promise<void>;
}

export interface ExecutionStorePorts {
  readonly checkpoints: CheckpointStore;
  readonly events: EventStore;
  readonly notifications: NotificationInbox;
  readonly runs: RunStore;
  readonly sessions: SessionStore;
}

export interface ExecutionStoreTransaction extends ExecutionStorePorts {}

export interface ExecutionStore extends ExecutionStorePorts {
  transaction<T>(fn: (tx: ExecutionStoreTransaction) => Promise<T>): Promise<T>;
}
