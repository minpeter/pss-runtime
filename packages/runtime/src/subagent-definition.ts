import type { Agent } from "./agent";

export interface SubagentDefinition {
  readonly agent: Agent;
  readonly delegateToolName?: string;
  readonly delegationMode?: "background-only" | "blocking-and-background";
  readonly description: string;
  readonly name: string;
}
