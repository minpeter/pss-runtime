import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";
import type { Llm, LlmOutput } from "./llm";
import type { AgentEventListener } from "./session/events";
import { modelMessageToAgentEvents } from "./session/mapping";

interface ModelHistory {
  appendModelMessage(message: ModelMessage): void;
  modelSnapshot(): ModelMessage[];
}

interface RunAgentLoopOptions {
  emit: AgentEventListener;
  history: ModelHistory;
  llm: Llm;
  signal?: AbortSignal;
}

export type AgentLoopResult = "completed" | "aborted";
type StepOutputResult = "continue" | "completed" | "aborted";
const INTERNAL_CONTINUE_TOOL_NAME = "continue";

export async function runAgentLoop({
  emit,
  history,
  llm,
  signal = new AbortController().signal,
}: RunAgentLoopOptions): Promise<AgentLoopResult> {
  while (true) {
    if (signal.aborted) {
      return "aborted";
    }

    emit({ type: "step-start" });
    const output = await readLlmOutput({ history, llm, signal });

    if (output === "aborted") {
      return "aborted";
    }

    const result = appendStepOutput({ emit, history, output, signal });

    if (result === "aborted") {
      return "aborted";
    }

    emit({ type: "step-end" });

    if (result === "completed") {
      return "completed";
    }
  }
}

async function readLlmOutput({
  history,
  llm,
  signal,
}: Pick<RunAgentLoopOptions, "history" | "llm"> & {
  signal: AbortSignal;
}): Promise<LlmOutput | "aborted"> {
  try {
    return await llm({ history: history.modelSnapshot(), signal });
  } catch (error) {
    if (signal.aborted) {
      return "aborted";
    }

    throw error;
  }
}

function appendStepOutput({
  emit,
  history,
  output,
  signal,
}: Pick<RunAgentLoopOptions, "emit" | "history"> & {
  output: LlmOutput;
  signal: AbortSignal;
}): StepOutputResult {
  if (signal.aborted) {
    return "aborted";
  }

  let shouldContinue = false;

  for (const message of output) {
    if (signal.aborted) {
      return "aborted";
    }

    for (const historyMessage of stripInternalContinueProtocol(message)) {
      history.appendModelMessage(historyMessage);
    }

    const events = modelMessageToAgentEvents(message);

    for (const event of events) {
      emit(event);
    }

    if (
      events.some(
        (event) =>
          event.type === "tool-call" &&
          event.toolName === INTERNAL_CONTINUE_TOOL_NAME
      )
    ) {
      shouldContinue = true;
    }
  }

  return shouldContinue ? "continue" : "completed";
}

function stripInternalContinueProtocol(message: ModelMessage): ModelMessage[] {
  if (message.role === "assistant") {
    const stripped = stripAssistantContinueToolCalls(message);
    return stripped ? [stripped] : [];
  }

  if (message.role === "tool") {
    return stripContinueToolResults(message);
  }

  return [message];
}

function stripAssistantContinueToolCalls(
  message: AssistantModelMessage
): AssistantModelMessage | null {
  if (typeof message.content === "string") {
    return message;
  }

  const content = message.content.filter(
    (part) =>
      part.type !== "tool-call" || part.toolName !== INTERNAL_CONTINUE_TOOL_NAME
  );

  if (!content.some(isPersistableAssistantContentPart)) {
    return null;
  }

  return content.length === message.content.length
    ? message
    : { ...message, content };
}

function isPersistableAssistantContentPart(
  part: Exclude<AssistantModelMessage["content"], string>[number]
): boolean {
  return part.type !== "text" || part.text !== "" || !!part.providerOptions;
}

function stripContinueToolResults(message: ToolModelMessage): ModelMessage[] {
  const continueResultCount = message.content.filter(
    (part) =>
      part.type === "tool-result" &&
      part.toolName === INTERNAL_CONTINUE_TOOL_NAME
  ).length;
  const content = message.content.filter(
    (part) =>
      part.type !== "tool-result" ||
      part.toolName !== INTERNAL_CONTINUE_TOOL_NAME
  );
  const messages: ModelMessage[] = [];

  if (content.length > 0) {
    messages.push(
      content.length === message.content.length
        ? message
        : { ...message, content }
    );
  }

  if (continueResultCount > 0) {
    messages.push({
      role: "user",
      content: `[internal tool result] The continue tool call completed successfully for this step. Count completed in this step: ${continueResultCount}. If more internal loop steps are still required, call continue again; otherwise answer normally without more continue calls.`,
    });
  }

  return messages;
}
