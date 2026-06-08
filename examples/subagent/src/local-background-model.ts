import type { RuntimeLlm } from "@minpeter/pss-runtime";
import type { AssistantModelMessage, LanguageModel } from "ai";

const delegateToolCallId = "call_local_delegate";
const outputToolCallId = "call_local_background_output";
const backgroundPrompt =
  "Give one sentence on why task IDs matter for background subagents.";
const taskIdPattern = /bg_[a-z0-9]+/i;

class LocalBackgroundModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalBackgroundModelError";
  }
}

export function createLocalCoordinatorModel(): LanguageModel {
  return {
    specificationVersion: "v4",
    provider: "pss-example",
    modelId: "local-background-coordinator",
    supportedUrls: {},
    doGenerate: ({ prompt }) => {
      const serializedPrompt = JSON.stringify(prompt);
      if (serializedPrompt.includes(outputToolCallId)) {
        return Promise.resolve(
          textResult(
            "Task completed. Task IDs let the parent track, retrieve, and cancel asynchronous subagent work without blocking the main turn."
          )
        );
      }

      if (serializedPrompt.includes("[BACKGROUND TASK COMPLETED]")) {
        return Promise.resolve(
          toolCallResult(
            outputToolCallId,
            "background_output",
            {
              block: true,
              task_id: extractTaskId(serializedPrompt),
            },
            "tool-calls"
          )
        );
      }

      if (serializedPrompt.includes(delegateToolCallId)) {
        return Promise.resolve(
          textResult("Launch recorded. Waiting for the background resume.")
        );
      }

      return Promise.resolve(
        toolCallResult(
          delegateToolCallId,
          "delegate_to_researcher",
          {
            prompt: backgroundPrompt,
            run_in_background: true,
          },
          "tool-calls"
        )
      );
    },
    doStream: () => {
      throw new LocalBackgroundModelError(
        "The local background example only uses non-streaming generation."
      );
    },
  } satisfies LanguageModel;
}

export const localResearcherModel: RuntimeLlm = async () => [
  assistantMessage(
    "Task IDs matter for background subagents because they let the parent track, retrieve, and cancel specific asynchronous jobs."
  ),
];

function assistantMessage(
  content: AssistantModelMessage["content"]
): AssistantModelMessage {
  return {
    content,
    role: "assistant",
  };
}

function textResult(text: string) {
  return {
    content: [{ text, type: "text" as const }],
    finishReason: { raw: "stop", unified: "stop" as const },
    usage: emptyUsage(),
    warnings: [],
  };
}

function toolCallResult(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  finishReason: "tool-calls"
) {
  return {
    content: [
      {
        input: JSON.stringify(input),
        toolCallId,
        toolName,
        type: "tool-call" as const,
      },
    ],
    finishReason: { raw: finishReason, unified: finishReason },
    usage: emptyUsage(),
    warnings: [],
  };
}

function emptyUsage() {
  return {
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
  };
}

function extractTaskId(value: string): string {
  const match = taskIdPattern.exec(value);
  if (!match) {
    throw new LocalBackgroundModelError(
      "The background completion reminder did not include a task id."
    );
  }

  return match[0];
}
