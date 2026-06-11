import type {
  AssistantModelMessage,
  LanguageModel,
  ModelMessage,
  ToolCallPart,
  ToolModelMessage,
  ToolSet,
} from "ai";
import { jsonSchema, tool } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import type { ModelGenerationOptions, ModelStepOutput } from "./llm";
import {
  createMockLanguageModelV4,
  type MockLanguageModelV4CallOptions,
  type MockLanguageModelV4GenerateResult,
} from "./mock-language-model-v4-test-utils";
import type {
  AgentEvent,
  UserMessage,
  UserMessageContent,
  UserText,
  UserTextContent,
} from "./session/events";

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

export const createScriptedModel = (
  outputs: readonly ModelStepOutput[]
): LanguageModel => createScriptedModelOptions(outputs).model;

export interface ScriptedModelOptions extends ModelGenerationOptions {
  readonly model: MockLanguageModelV4;
}

interface CallbackModelContext {
  readonly history: readonly ModelMessage[];
  readonly signal?: AbortSignal;
}

export function createCallbackModel(
  callback: (
    context: CallbackModelContext
  ) => ModelStepOutput | Promise<ModelStepOutput>
): MockLanguageModelV4 {
  return createMockLanguageModelV4(async ({ abortSignal, prompt }) =>
    modelResultForOutput(
      await callback({
        history: runtimeHistoryFromPrompt(prompt),
        signal: abortSignal,
      })
    )
  );
}

export const createScriptedModelOptions = (
  outputs: readonly ModelStepOutput[]
): ScriptedModelOptions => {
  const tools = toolsForModelOutputs(outputs);
  return {
    model: createMockLanguageModelV4(outputs.map(modelResultForOutput)),
    ...(Object.keys(tools).length === 0 ? {} : { tools }),
  };
};

type MockLanguageModelV4ContentPart =
  MockLanguageModelV4GenerateResult["content"][number];
type ToolResultContent = Extract<
  ToolModelMessage["content"][number],
  { readonly type: "tool-result" }
>;
type JsonToolResultOutput = Extract<
  ToolResultContent["output"],
  { readonly type: "json" }
>;

export const eventTypes = (events: AgentEvent[]) =>
  events.map((event) => event.type);

function modelResultForOutput(
  output: ModelStepOutput
): MockLanguageModelV4GenerateResult {
  const assistant = output.find((message) => message.role === "assistant");
  return {
    content: assistant ? assistantContentForModel(assistant.content) : [],
    finishReason: { raw: "stop", unified: "stop" },
    usage: {
      inputTokens: {
        cacheRead: undefined,
        cacheWrite: undefined,
        noCache: undefined,
        total: undefined,
      },
      outputTokens: {
        reasoning: undefined,
        text: undefined,
        total: undefined,
      },
    },
    warnings: [],
  };
}

function assistantContentForModel(
  content: AssistantModelMessage["content"]
): MockLanguageModelV4GenerateResult["content"] {
  if (typeof content === "string") {
    return [{ text: content, type: "text" }];
  }

  const result: MockLanguageModelV4ContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      result.push({ text: part.text, type: "text" });
      continue;
    }

    if (part.type === "tool-call") {
      result.push({
        input: JSON.stringify(part.input),
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        type: "tool-call",
      });
    }
  }
  return result;
}

function toolsForModelOutputs(outputs: readonly ModelStepOutput[]): ToolSet {
  return Object.fromEntries(
    outputs.flatMap((output) =>
      output.flatMap((message) =>
        message.role === "tool"
          ? message.content
              .filter(
                (result): result is ToolResultContent =>
                  result.type === "tool-result"
              )
              .map((result) => [
                result.toolName,
                tool({
                  execute: () => toolResultOutputValue(result.output),
                  inputSchema: jsonSchema({
                    additionalProperties: true,
                    properties: {},
                    type: "object",
                  }),
                }),
              ])
          : []
      )
    )
  );
}

function toolResultOutputValue(output: ToolResultContent["output"]) {
  return isJsonToolOutput(output) ? output.value : output;
}

function isJsonToolOutput(
  output: ToolResultContent["output"]
): output is JsonToolResultOutput {
  return (
    typeof output === "object" &&
    output !== null &&
    "type" in output &&
    output.type === "json" &&
    "value" in output
  );
}

function runtimeHistoryFromPrompt(
  prompt: MockLanguageModelV4CallOptions["prompt"]
): ModelMessage[] {
  return prompt.map(
    (message) =>
      ({
        ...message,
        content: runtimeContentFromPromptContent(message.content),
      }) as ModelMessage
  );
}

function runtimeContentFromPromptContent(
  content: MockLanguageModelV4CallOptions["prompt"][number]["content"]
): ModelMessage["content"] {
  if (!Array.isArray(content)) {
    return content;
  }

  if (content.length === 1 && content[0]?.type === "text") {
    return content[0].text;
  }

  return content.map((part) => {
    if (
      part.type === "file" &&
      typeof part.data === "object" &&
      part.data !== null &&
      "type" in part.data &&
      part.data.type === "data" &&
      "data" in part.data
    ) {
      return {
        ...part,
        data: part.data.data,
      };
    }

    return part;
  }) as ModelMessage["content"];
}

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
