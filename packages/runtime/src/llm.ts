import type {
  AssistantModelMessage,
  LanguageModel,
  ModelMessage,
  ToolModelMessage,
  ToolSet,
} from "ai";
import { generateText } from "ai";

const toolCallIdPrefix = "call_";
const publicToolCallIdPattern = /^call[-_]/;

export type AgentToolChoice = "auto" | "required";
export type RuntimeLlmOutput = Awaited<
  ReturnType<typeof generateText>
>["responseMessages"];
export type RuntimeLlmOutputPart = RuntimeLlmOutput[number];
type RuntimeLlmMessage = RuntimeLlmOutput[number];

export interface RuntimeLlmContext {
  history: readonly ModelMessage[];
  signal: AbortSignal;
}

export type RuntimeLlm = (
  context: RuntimeLlmContext
) => Promise<RuntimeLlmOutput>;

export interface RuntimeCreateLlmOptions {
  instructions?: string;
  model: LanguageModel;
  toolChoice?: AgentToolChoice;
  tools?: ToolSet;
}

export function createLlm({
  model,
  instructions,
  toolChoice,
  tools,
}: RuntimeCreateLlmOptions): RuntimeLlm {
  return async ({ history, signal }) => {
    const toolCallIds = new Map<string, string>();
    const { responseMessages } = await generateText({
      abortSignal: signal,
      instructions,
      messages: [...history],
      model,
      toolChoice,
      tools: normalizeToolCallIds(tools, toolCallIds),
    });

    return responseMessages.map((message) =>
      rewriteMessageToolCallIds(message, toolCallIds)
    );
  };
}

function createToolCallId(): string {
  return `${toolCallIdPrefix}${crypto.randomUUID().replaceAll("-", "")}`;
}

function normalizeToolCallIds(
  tools: ToolSet | undefined,
  toolCallIds: Map<string, string>
): ToolSet | undefined {
  if (!tools) {
    return;
  }

  return Object.fromEntries(
    Object.entries(tools).map(([name, candidate]) => [
      name,
      wrapToolExecute(candidate, toolCallIds),
    ])
  ) as ToolSet;
}

function wrapToolExecute(
  toolDefinition: unknown,
  toolCallIds: Map<string, string>
): unknown {
  if (!isExecutableToolDefinition(toolDefinition)) {
    return toolDefinition;
  }

  const { execute } = toolDefinition;
  return {
    ...toolDefinition,
    execute: (input: unknown, options: ToolExecutionOptionsLike) =>
      execute(input, {
        ...options,
        toolCallId: publicToolCallId(options.toolCallId, toolCallIds),
      }),
  };
}

function isExecutableToolDefinition(value: unknown): value is {
  readonly execute: (
    input: unknown,
    options: ToolExecutionOptionsLike
  ) => unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

interface ToolExecutionOptionsLike {
  readonly toolCallId: string;
}

function rewriteMessageToolCallIds(
  message: RuntimeLlmMessage,
  toolCallIds: Map<string, string>
): RuntimeLlmMessage {
  if (message.role === "assistant") {
    return rewriteAssistantToolCallIds(message, toolCallIds);
  }

  if (message.role === "tool") {
    return rewriteToolResultCallIds(message, toolCallIds);
  }

  return message;
}

function rewriteAssistantToolCallIds(
  message: AssistantModelMessage,
  toolCallIds: Map<string, string>
): AssistantModelMessage {
  if (typeof message.content === "string") {
    return message;
  }

  return {
    ...message,
    content: message.content.map((part) =>
      "toolCallId" in part
        ? {
            ...part,
            toolCallId: publicToolCallId(part.toolCallId, toolCallIds),
          }
        : part
    ),
  };
}

function rewriteToolResultCallIds(
  message: ToolModelMessage,
  toolCallIds: Map<string, string>
): ToolModelMessage {
  return {
    ...message,
    content: message.content.map((part) =>
      "toolCallId" in part
        ? {
            ...part,
            toolCallId: publicToolCallId(part.toolCallId, toolCallIds),
          }
        : part
    ),
  };
}

function publicToolCallId(
  toolCallId: string,
  toolCallIds: Map<string, string>
): string {
  if (publicToolCallIdPattern.test(toolCallId)) {
    return toolCallId;
  }

  const existing = toolCallIds.get(toolCallId);
  if (existing) {
    return existing;
  }

  const generated = createToolCallId();
  toolCallIds.set(toolCallId, generated);
  return generated;
}
