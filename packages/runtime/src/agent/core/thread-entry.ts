import type {
  AgentInput,
  NotifyOptions,
  ThreadCompactionInput,
  UserInput,
} from "../../thread/handle/thread";
import type { AgentTurn } from "../../thread/protocol/turn";
import { namespacePart } from "../identity/namespace";

export interface ThreadMetadata {
  readonly [key: string]: unknown;
}

export interface ThreadAddress {
  readonly key: string;
  readonly metadata?: ThreadMetadata;
  readonly scope?: string;
}

export type ThreadKey = string | ThreadAddress;

export interface ThreadHandle {
  compact(input: ThreadCompactionInput): Promise<void>;
  delete(): Promise<void>;
  dispose(): Promise<void>;
  interrupt(): void;
  overlay(input: AgentInput): ThreadHandle;
  send(input: AgentInput): Promise<AgentTurn>;
  steer(input: AgentInput): Promise<AgentTurn>;
}

export interface AgentThreadEntry {
  notify(
    input: AgentInput | UserInput,
    options?: NotifyOptions
  ): Promise<AgentTurn>;
  readonly publicHandle: ThreadHandle;
}

export function normalizeThreadKey(thread: ThreadKey): string {
  if (typeof thread === "string") {
    return thread;
  }

  if (thread.scope === undefined) {
    return thread.key;
  }

  return `scope:${namespacePart(thread.scope)}:thread:${namespacePart(
    thread.key
  )}`;
}
