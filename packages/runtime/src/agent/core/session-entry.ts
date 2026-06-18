import type { AgentInput, NotifyOptions } from "../../session/handle/session";
import type { AgentRun } from "../../session/protocol/run";

export interface SessionHandle {
  delete(): Promise<void>;
  dispose(): Promise<void>;
  interrupt(): void;
  send(input: AgentInput): Promise<AgentRun>;
  steer(input: AgentInput): Promise<AgentRun>;
}

export interface AgentSessionEntry {
  notify(input: AgentInput, options?: NotifyOptions): Promise<AgentRun>;
  readonly publicHandle: SessionHandle;
}
