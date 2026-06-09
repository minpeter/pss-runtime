import type {
  AssistantModelMessage,
  LanguageModel,
  ToolCallPart,
  ToolModelMessage,
} from "ai";
import { Agent, type AgentOptions } from "./agent";
import type { AgentHost } from "./execution/types";
import type { RuntimeLlm, RuntimeLlmOutput } from "./llm";
import type { AgentPlugin } from "./plugins";
import type {
  AgentEvent,
  UserMessage,
  UserMessageContent,
  UserText,
  UserTextContent,
} from "./session/events";
import type { SubagentDefinition } from "./subagent-definition";

export const assistantMessage = (
  content: AssistantModelMessage["content"]
): AssistantModelMessage => ({
  role: "assistant",
  content,
});

export const toolCallPart = (
  toolCallId: string,
  toolName = "test_tool",
  input: unknown = {}
): ToolCallPart => ({
  type: "tool-call",
  toolCallId,
  toolName,
  input,
});

export const toolResultFor = (toolCall: ToolCallPart): ToolModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      output: { type: "json", value: {} },
    },
  ],
});

export const createDeferred = (): {
  promise: Promise<void>;
  resolve: () => void;
} => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

export const createScriptedLlm = (outputs: RuntimeLlmOutput[]): RuntimeLlm => {
  let index = 0;
  return () => Promise.resolve(outputs[index++] ?? []);
};

export const eventTypes = (events: AgentEvent[]) =>
  events.map((event) => event.type);

export const userText = (text: UserTextContent): UserText => ({
  type: "user-text",
  text,
});

export const sentUserText = (text: UserTextContent): UserText => ({
  meta: { source: "send" },
  text,
  type: "user-text",
});

export const userMessage = (content: UserMessageContent): UserMessage => ({
  type: "user-message",
  content,
});

export const sentUserMessage = (content: UserMessageContent): UserMessage => ({
  content,
  meta: { source: "send" },
  type: "user-message",
});

export const steerRuntimeInput = (
  text: UserTextContent,
  placement: "step-end" | "step-start" | "turn-start"
) => ({
  input: {
    meta: { source: "steer", streaming: "steer" as const },
    text,
    type: "user-text" as const,
  },
  meta: { source: "steer" as const, streaming: "steer" as const },
  placement,
  type: "runtime-input" as const,
});

export const notifyRuntimeInput = (
  text: UserTextContent,
  placement: "step-end" | "step-start" | "turn-start" = "turn-start"
) => ({
  input: {
    meta: { source: "notify" as const },
    text,
    type: "user-text" as const,
  },
  meta: { source: "notify" as const },
  placement,
  type: "runtime-input" as const,
});

export const steerRuntimeInputMessage = (
  content: UserMessageContent,
  placement: "step-end" | "step-start" | "turn-start"
) => ({
  input: {
    content,
    meta: { source: "steer" as const, streaming: "steer" as const },
    type: "user-message" as const,
  },
  meta: { source: "steer" as const, streaming: "steer" as const },
  placement,
  type: "runtime-input" as const,
});

export interface ResearcherSubagentOverrides {
  readonly agent?: Agent;
  readonly delegateToolName?: string;
  readonly delegationMode?: SubagentDefinition["delegationMode"];
  readonly description?: string;
  readonly host?: AgentHost;
  readonly instructions?: string;
  readonly model?: LanguageModel | RuntimeLlm;
  readonly name?: string;
  readonly namespace?: string;
  readonly plugins?: readonly AgentPlugin[];
  readonly tools?: import("ai").ToolSet;
}

export function researcherSubagent(
  overrides: ResearcherSubagentOverrides = {}
): SubagentDefinition {
  const name = overrides.name ?? "researcher";
  const description = overrides.description ?? "Researches facts.";
  const model = overrides.model ?? ({} as LanguageModel);
  const namespace = overrides.namespace ?? name;
  const sharedOptions = {
    description,
    host: overrides.host,
    namespace,
    plugins: overrides.plugins,
    tools: overrides.tools,
  };
  const agent =
    overrides.agent ??
    (typeof model === "function"
      ? new Agent({ ...sharedOptions, model } as AgentOptions)
      : new Agent({
          ...sharedOptions,
          instructions: overrides.instructions ?? "Research facts.",
          model,
        }));

  return {
    agent,
    delegateToolName: overrides.delegateToolName,
    delegationMode: overrides.delegationMode,
    description,
    name,
  };
}
