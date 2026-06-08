import type { AgentRun } from "./session/run";
import type { AgentInput, NotifyOptions } from "./session/session";

export interface SessionHandle {
  delete(): Promise<void>;
  interrupt(): void;
  kill(): Promise<void>;
  send(input: AgentInput): Promise<AgentRun>;
  steer(input: AgentInput): Promise<AgentRun>;
}

export interface AgentSessionEntry {
  notify(input: AgentInput, options?: NotifyOptions): Promise<AgentRun>;
  readonly publicHandle: SessionHandle;
}
