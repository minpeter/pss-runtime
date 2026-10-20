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
   * Continue the latest unfinished task from its current checkpoint without
   * adding a user message; returns undefined when no checkpoint exists.
   * Busy/queued work rejects with code THREAD_CONTINUATION_BUSY. An optional
   * signal cancels pending admission; accepted turns always end explicitly.
   * New user work supersedes checkpoints. Interrupted or failed runs are
   * terminal: they continue only in this process, not after a reload. Only
   * runs a crash left non-terminal are recovered from the host. Completed
   * tools are kept, never replayed, when recovery can rebuild them; otherwise
   * the run fails closed as `needs-recovery`.
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

export function resolveThreadIdentity(thread: ThreadKey): ThreadIdentity {
  if (typeof thread === "string") {
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

const scopedThreadStoreKey = /^scope:([^:]*):thread:([^:]*)$/;

/** Reverses `threadStoreKey` for keys read back from durable records. */
export function threadIdentityFromStoreKey(key: string): ThreadIdentity {
  const match = scopedThreadStoreKey.exec(key);
  if (match !== null) {
    try {
      return Object.freeze({
        id: decodeURIComponent(match[2] ?? ""),
        scope: decodeURIComponent(match[1] ?? ""),
      });
    } catch {
      // Malformed escapes keep the verbatim store key as the id.
    }
  }
  return Object.freeze({ id: key });
}
