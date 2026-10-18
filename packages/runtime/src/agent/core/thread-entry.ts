import type {
  Checkpoint,
  StoredThreadEvent,
  ThreadEventReadOptions,
} from "../../execution/host/types";
import type { AgentInput, UserInput } from "../../thread/input/input";
import type {
  AgentTurn,
  ThreadContinuationOptions,
} from "../../thread/protocol/turn";
import type {
  CompactionSummaryOptions,
  ManualThreadCompactionResult,
} from "../../thread/runtime/auto-compaction-types";
import type { QueuedThreadExecutionRun } from "../../thread/runtime/execution";
import type { NotifyOptions } from "../../thread/runtime/notification";
import type { ThreadCompactionInput } from "../../thread/state/thread-state";
import { namespacePart } from "../identity/namespace";

export type ThreadId = string;

export interface ThreadIdentity {
  readonly id: ThreadId;
  readonly scope?: string;
}

export type ThreadReplayOptions = ThreadEventReadOptions;

export interface ThreadMetadata {
  readonly [key: string]: unknown;
}

export interface ThreadAddress {
  readonly key: string;
  readonly metadata?: ThreadMetadata;
  readonly scope?: string;
}

export type ThreadKey = ThreadId | ThreadIdentity | ThreadAddress;

export interface ThreadHandle extends AsyncDisposable {
  compact(input: ThreadCompactionInput): Promise<boolean>;
  compact(
    options?: CompactionSummaryOptions
  ): Promise<ManualThreadCompactionResult>;
  /**
   * Continue the latest safely stopped unfinished task on this handle or host.
   * Adds no user message; returns undefined only without a current checkpoint.
   * Busy/queued work rejects with code THREAD_CONTINUATION_BUSY. An optional
   * signal cancels pending admission; accepted turns always end explicitly.
   * New user work supersedes checkpoints. Completed tools are retained, never replayed.
   */
  continue(options?: ThreadContinuationOptions): Promise<AgentTurn | undefined>;
  delete(): Promise<void>;
  dispose(): Promise<void>;
  events(options?: ThreadEventReadOptions): AsyncIterable<StoredThreadEvent>;
  followUp(input: AgentInput): Promise<AgentTurn>;
  readonly identity: ThreadIdentity;
  interrupt(): void;
  overlay(input: AgentInput): ThreadHandle;
  replay(options?: ThreadReplayOptions): AsyncIterable<StoredThreadEvent>;
  send(input: AgentInput): Promise<AgentTurn>;
  steer(input: AgentInput): Promise<AgentTurn>;
}

export interface AgentThreadEntry {
  notify(
    input: AgentInput | UserInput,
    options?: NotifyOptions
  ): Promise<AgentTurn>;
  readonly publicHandle: ThreadHandle;
  resumeExecutionRun(
    executionRun: QueuedThreadExecutionRun,
    checkpoint: Checkpoint | null
  ): Promise<AgentTurn>;
}

const ENCODED_SCOPE_THREAD_PATTERN = /^scope:([^:]*):thread:([^:]*)$/;

export function resolveThreadIdentity(thread: ThreadKey): ThreadIdentity {
  if (typeof thread === "string") {
    const match = ENCODED_SCOPE_THREAD_PATTERN.exec(thread);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      return Object.freeze({
        id: decodeURIComponent(match[2]),
        scope: decodeURIComponent(match[1]),
      });
    }
    return Object.freeze({ id: thread });
  }

  const id = "id" in thread ? thread.id : thread.key;
  return Object.freeze(
    thread.scope === undefined ? { id } : { id, scope: thread.scope }
  );
}

export function threadStoreKey(thread: ThreadKey): string {
  if (typeof thread === "string") {
    return thread;
  }

  const id = "id" in thread ? thread.id : thread.key;
  if (thread.scope === undefined) {
    return id;
  }

  return `scope:${namespacePart(thread.scope)}:thread:${namespacePart(id)}`;
}
