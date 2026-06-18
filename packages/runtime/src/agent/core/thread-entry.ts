import type { AgentInput, NotifyOptions } from "../../session/handle/session";
import type { AgentRun } from "../../session/protocol/run";
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

export function threadSessionKey(thread: ThreadKey): string {
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
