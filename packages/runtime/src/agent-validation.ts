import type { ToolSet } from "ai";
import type { Agent } from "./agent";
import type { AgentOptions } from "./agent-options";

const subagentNamePattern = /^[a-z][a-z0-9_-]{0,51}$/;

export function assertSubagents(
  options: AgentOptions,
  agentClass: new (options: AgentOptions) => Agent,
  hasRuntimeModel: boolean
): void {
  if (!("subagents" in options) || options.subagents === undefined) {
    return;
  }

  if (hasRuntimeModel) {
    throw new TypeError("Agent: subagents require an AI SDK model.");
  }

  if (!Array.isArray(options.subagents)) {
    throw new TypeError("Agent: subagents must be an array.");
  }

  assertSubagentTools(options.subagents, agentClass, options.tools ?? {});
}

function assertSubagentTools(
  subagents: readonly Agent[],
  agentClass: new (options: AgentOptions) => Agent,
  tools: ToolSet
): void {
  const toolNames = new Set(Object.keys(tools));
  const generatedToolNames = new Set<string>();
  for (const [index, subagent] of subagents.entries()) {
    const name = assertSubagentMetadata(subagent, index, agentClass);
    const toolName = `delegate_to_${name.replaceAll("-", "_")}`;
    if (toolNames.has(toolName)) {
      throw new TypeError(
        `Agent: subagent tool ${toolName} collides with an existing tool.`
      );
    }

    if (generatedToolNames.has(toolName)) {
      throw new TypeError(`Agent: duplicate subagent tool name ${toolName}.`);
    }

    generatedToolNames.add(toolName);
  }

  for (const reservedToolName of ["background_output", "background_cancel"]) {
    if (toolNames.has(reservedToolName)) {
      throw new TypeError(
        `Agent: ${reservedToolName} collides with a reserved subagent tool.`
      );
    }
  }
}

function assertSubagentMetadata(
  subagent: Agent,
  index: number,
  agentClass: new (options: AgentOptions) => Agent
): string {
  if (!(subagent instanceof agentClass)) {
    throw new TypeError(`Agent: subagents[${index}] must be an Agent.`);
  }

  if (!isValidSubagentName(subagent.name)) {
    throw new TypeError(
      `Agent: subagents[${index}].name is required or too long.`
    );
  }

  if (!isNonEmptyText(subagent.description)) {
    throw new TypeError(`Agent: subagents[${index}].description is required.`);
  }

  return subagent.name;
}

function isNonEmptyText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidSubagentName(value: string | undefined): value is string {
  return typeof value === "string" && subagentNamePattern.test(value);
}
