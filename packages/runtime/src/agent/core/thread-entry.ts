import type { AgentInput, NotifyOptions } from "../../thread/handle/thread";
import type { AgentRun } from "../../thread/protocol/run";
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
  delete(): Promise<void>;
  dispose(): Promise<void>;
  interrupt(): void;
  send(input: AgentInput): Promise<AgentRun>;
  steer(input: AgentInput): Promise<AgentRun>;
}

export interface AgentThreadEntry {
  notify(input: AgentInput, options?: NotifyOptions): Promise<AgentRun>;
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
