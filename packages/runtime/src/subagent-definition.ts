import type { Agent } from "./agent";

export interface SubagentDefinition {
  readonly agent: Agent;
  readonly delegateToolName?: string;
  readonly description: string;
  readonly name: string;
}