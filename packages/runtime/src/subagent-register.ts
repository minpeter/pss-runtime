import type { Agent } from "./agent";
import type { AgentInput } from "./session/input";
import type { AgentRun } from "./session/run";
import type { SubagentDefinition } from "./subagent-definition";
import type { Subagent } from "./subagent-types";

export class RegisteredSubagent implements Subagent {
  readonly delegateToolName?: string;
  readonly delegationMode?: SubagentDefinition["delegationMode"];
  readonly description: string;
  readonly name: string;
  readonly #agent: Agent;

  constructor(definition: SubagentDefinition) {
    this.delegateToolName = definition.delegateToolName;
    this.delegationMode = definition.delegationMode;
    this.description = definition.description;
    this.name = definition.name;
    this.#agent = definition.agent;
  }

  session(key: string): {
    delete(): Promise<void>;
    interrupt(): void;
    send(input: AgentInput): Promise<AgentRun>;
  } {
    return this.#agent.session(key);
  }
}

export function registerSubagents(
  definitions: readonly SubagentDefinition[]
): readonly RegisteredSubagent[] {
  return definitions.map((definition) => new RegisteredSubagent(definition));
}
