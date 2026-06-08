import type { RuntimeLlm } from "@minpeter/pss-runtime";
import type { AssistantModelMessage, LanguageModel } from "ai";
import type { ScenarioId } from "./request-schema";

const delegateToolCallId = "call_cloudflare_delegate";
const cancelToolCallId = "call_cloudflare_background_cancel";
const outputToolCallId = "call_cloudflare_background_output";
const stressToolCallId = "call_worker_echo";
const taskIdPattern = /bg_[a-z0-9]+/i;

export function createWorkerCoordinatorModel(): LanguageModel {
  return createStressModel("durable-background");
}

export function createStressModel(scenario: ScenarioId): LanguageModel {
  return {
    specificationVersion: "v4",
    provider: "pss-agent-worker",
    modelId: `cloudflare-worker-${scenario}`,
    supportedUrls: {},
    doGenerate: ({ prompt }) => {
      const serializedPrompt = JSON.stringify(prompt);
      if (scenario === "tool-choice") {
        return Promise.resolve(toolChoiceResult(serializedPrompt));
      }
      if (scenario === "blocking-subagent") {
        return Promise.resolve(blockingSubagentResult(serializedPrompt));
      }
      if (scenario === "background-cancel") {
        return Promise.resolve(backgroundCancelResult(serializedPrompt));
      }
      if (scenario === "steer-step-end") {
        return Promise.resolve(steerResult(serializedPrompt));
      }
      if (
        scenario !== "durable-background" &&
        scenario !== "background-output"
      ) {
        return Promise.resolve(textResult(`scenario:${scenario}:complete`));
      }

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

function toolChoiceResult(serializedPrompt: string) {
  if (serializedPrompt.includes(stressToolCallId)) {
    return textResult("Tool choice used worker_echo.");
  }

  return toolCallResult(stressToolCallId, "worker_echo", {
    message: "tool-choice",
  });
}

function blockingSubagentResult(serializedPrompt: string) {
  if (serializedPrompt.includes(delegateToolCallId)) {
    return textResult("Blocking subagent result consumed.");
  }

  return toolCallResult(delegateToolCallId, "delegate_to_researcher", {
    prompt: "Give one sentence for a blocking Cloudflare subagent.",
    run_in_background: false,
  });
}

function backgroundCancelResult(serializedPrompt: string) {
  if (serializedPrompt.includes(cancelToolCallId)) {
    return textResult("Background task was cancelled before alarm delivery.");
  }
  if (serializedPrompt.includes(delegateToolCallId)) {
    return toolCallResult(cancelToolCallId, "background_cancel", {
      task_id: extractTaskId(serializedPrompt),
    });
  }

  return toolCallResult(delegateToolCallId, "delegate_to_researcher", {
    prompt: "Start cancellable background research.",
    run_in_background: true,
  });
}

function steerResult(serializedPrompt: string) {
  return textResult(
    serializedPrompt.includes("step-end steer input")
      ? "DONE"
      : "This could be final."
  );
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
