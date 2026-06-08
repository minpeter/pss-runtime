import type { RuntimeLlm } from "@minpeter/pss-runtime";
import type { AssistantModelMessage, LanguageModel } from "ai";

const delegateToolCallId = "call_cloudflare_delegate";
const outputToolCallId = "call_cloudflare_background_output";
const taskIdPattern = /bg_[a-z0-9]+/i;

export function createWorkerCoordinatorModel(): LanguageModel {
  return {
    specificationVersion: "v4",
    provider: "pss-example",
    modelId: "cloudflare-worker-coordinator",
    supportedUrls: {},
    doGenerate: ({ prompt }) => {
      const serializedPrompt = JSON.stringify(prompt);
      if (serializedPrompt.includes(outputToolCallId)) {
        return Promise.resolve(
          textResult(
            "Background result retrieved after the Durable Object alarm resumed the child run."
          )
        );
      }

      if (serializedPrompt.includes("[BACKGROUND TASK COMPLETED]")) {
        return Promise.resolve(
          toolCallResult(outputToolCallId, "background_output", {
            block: true,
            task_id: extractTaskId(serializedPrompt),
          })
        );
      }

      if (serializedPrompt.includes(delegateToolCallId)) {
        return Promise.resolve(
          textResult("Background task launched; awaiting durable resume.")
        );
      }

      return Promise.resolve(
        toolCallResult(delegateToolCallId, "delegate_to_researcher", {
          prompt:
            "Give one sentence on why task IDs matter for background subagents.",
          run_in_background: true,
        })
      );
    },
    doStream: () => {
      throw new Error(
        "The Cloudflare worker example uses non-streaming calls."
      );
    },
  } satisfies LanguageModel;
}

export const workerResearcherModel: RuntimeLlm = async () => [
  assistantMessage(
    "Task IDs let the parent resume, retrieve, and cancel exact background subagent jobs across request boundaries."
  ),
];

function assistantMessage(
  content: AssistantModelMessage["content"]
): AssistantModelMessage {
  return { content, role: "assistant" };
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
  input: Record<string, unknown>
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
    finishReason: { raw: "tool-calls", unified: "tool-calls" as const },
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
    throw new Error(
      "Background completion reminder did not include a task id."
    );
  }
  return match[0];
}
