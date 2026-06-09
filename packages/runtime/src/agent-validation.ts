import type { ToolSet } from "ai";
import type { Agent } from "./agent";
import { sessionStoreForHost } from "./agent-host-session-store";
import type { AgentConstructionOptions } from "./agent-options";
import type { AgentHost } from "./execution/types";
import type { SubagentDefinition } from "./subagent-definition";

const subagentNamePattern = /^[a-z][a-z0-9_-]{0,51}$/;
const delegateToolNamePattern = /^[a-z][a-z0-9_]{0,63}$/;
const subagentDelegationModes = new Set([
  "background-only",
  "blocking-and-background",
]);
const subagentUnwrappedPattern =
  /SubagentDefinition wrappers with an agent field, not raw Agent instances/;
const forbiddenWrapperFields = [
  "host",
  "instructions",
  "model",
  "namespace",
  "plugins",
  "tools",
] as const;

export function resolveSubagentDelegateToolName(subagent: {
  readonly delegateToolName?: string;
  readonly name?: string;
}): string {
  const name = subagent.name ?? "subagent";
  return (
    subagent.delegateToolName ?? `delegate_to_${name.replaceAll("-", "_")}`
  );
}

export function assertSubagents(
  options: AgentConstructionOptions,
  _agentClass: new (options: AgentConstructionOptions) => Agent,
  hasRuntimeModelOption: boolean
): void {
  if (!("subagents" in options) || options.subagents === undefined) {
    return;
  }

  if (hasRuntimeModelOption) {
    throw new TypeError("Agent: subagents require an AI SDK model.");
  }

  if (!Array.isArray(options.subagents)) {
    throw new TypeError("Agent: subagents must be an array.");
  }

  assertSubagentDefinitions({
    parentHost: options.host,
    parentHostExplicit: "host" in options && options.host !== undefined,
    subagents: options.subagents,
    tools: options.tools ?? {},
  });
}

function assertSubagentDefinitions({
  parentHost,
  parentHostExplicit,
  subagents,
  tools,
}: {
  readonly parentHost: AgentHost | undefined;
  readonly parentHostExplicit: boolean;
  readonly subagents: readonly SubagentDefinition[];
  readonly tools: ToolSet;
}): void {
  const toolNames = new Set(Object.keys(tools));
  const generatedToolNames = new Set<string>();
  for (const [index, subagent] of subagents.entries()) {
    if (
      subagent === null ||
      typeof subagent !== "object" ||
      Array.isArray(subagent)
    ) {
      throw new TypeError(
        `Agent: subagents[${index}] must be a SubagentDefinition object.`
      );
    }

    if (isAgentLike(subagent) && !("agent" in subagent)) {
      throw new TypeError(subagentUnwrappedPattern.source);
    }

    assertForbiddenWrapperFields(
      subagent as SubagentDefinition & Record<string, unknown>,
      index
    );
    const nestedAgent = assertNestedAgent(subagent, index);
    assertNestedAgentHasNamespace(nestedAgent, index);
    assertNestedAgentHasNoSubagents(nestedAgent, index);
    assertSubagentHostConsistency(
      parentHost,
      parentHostExplicit,
      nestedAgent,
      index
    );

    assertSubagentMetadata(subagent, index);
    assertDelegateToolName(subagent, index);
    assertDelegationMode(subagent, index);
    const toolName = resolveSubagentDelegateToolName(subagent);
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

function assertDelegationMode(
  subagent: SubagentDefinition,
  index: number
): void {
  if (
    subagent.delegationMode !== undefined &&
    !subagentDelegationModes.has(subagent.delegationMode)
  ) {
    throw new TypeError(
      `Agent: subagents[${index}].delegationMode must be "background-only" or "blocking-and-background".`
    );
  }
}

function assertForbiddenWrapperFields(
  subagent: Record<string, unknown>,
  index: number
): void {
  for (const field of forbiddenWrapperFields) {
    if (field in subagent && subagent[field] !== undefined) {
      throw new TypeError(
        `Agent: subagents[${index}].${field} must be set on the nested agent, not the SubagentDefinition wrapper.`
      );
    }
  }
}

function isAgentLike(value: unknown): value is Agent {
  return (
    typeof value === "object" &&
    value !== null &&
    "session" in value &&
    typeof value.session === "function" &&
    "host" in value &&
    "subagentCount" in value
  );
}

function assertNestedAgent(subagent: SubagentDefinition, index: number): Agent {
  if (!("agent" in subagent && isAgentLike(subagent.agent))) {
    throw new TypeError(
      `Agent: subagents[${index}] must include an agent field with an Agent instance.`
    );
  }

  return subagent.agent;
}

function assertNestedAgentHasNamespace(
  nestedAgent: Agent,
  index: number
): void {
  if (nestedAgent.namespace === undefined) {
    throw new TypeError(
      `Agent: subagents[${index}].agent.namespace is required.`
    );
  }
}

function assertNestedAgentHasNoSubagents(
  nestedAgent: Agent,
  index: number
): void {
  if (nestedAgent.subagentCount > 0) {
    throw new TypeError(
      `Agent: subagents[${index}].agent cannot define nested subagents.`
    );
  }
}

function assertSubagentHostConsistency(
  parentHost: AgentHost | undefined,
  parentHostExplicit: boolean,
  nestedAgent: Agent,
  index: number
): void {
  if (!parentHostExplicit || parentHost === undefined) {
    return;
  }

  if (parentHost === nestedAgent.host) {
    return;
  }

  if (
    sessionStoreForHost(parentHost) === sessionStoreForHost(nestedAgent.host)
  ) {
    return;
  }

  throw new TypeError(
    `Agent: subagents[${index}].agent must use the same host as the parent agent.`
  );
}

function assertSubagentMetadata(
  subagent: SubagentDefinition,
  index: number
): string {
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

function assertDelegateToolName(
  subagent: SubagentDefinition,
  index: number
): void {
  const delegateToolName = subagent.delegateToolName;
  if (delegateToolName === undefined) {
    return;
  }

  if (!delegateToolNamePattern.test(delegateToolName)) {
    throw new TypeError(
      `Agent: subagents[${index}].delegateToolName is invalid.`
    );
  }
}
