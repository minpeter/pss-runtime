import {
  type Agent,
  type AgentInput,
  type AgentRun,
  delegateUserInput,
} from "@minpeter/pss-runtime";
import { defaultChildThreadKey } from "@minpeter/pss-runtime/namespace";
import { jsonSchema, tool } from "ai";

export const delegateToolName = "delegate_to_reader";
export const readerChildName = "reader";

interface DelegateInput {
  readonly prompt: string;
}

export function createDelegateToReaderTool(options: {
  readonly description: string;
  readonly parentAgentNamespace: string;
  readonly parentThreadKey: string;
  readonly readerAgent: Agent;
}) {
  return tool<DelegateInput, unknown, Record<string, unknown>>({
    description: options.description,
    execute: async (input, { abortSignal }) => {
      if (abortSignal?.aborted) {
        throw new Error("Delegation was aborted before it started.");
      }

      const prompt = delegateUserInput(input.prompt, { delegateToolName });
      const childThreadKey = defaultChildThreadKey(
        options.parentAgentNamespace,
        options.parentThreadKey,
        readerChildName
      );

      return await runBlockingDelegation({
        abortSignal,
        prompt,
        readerAgent: options.readerAgent,
        threadKey: childThreadKey,
      });
    },
    inputSchema: jsonSchema<DelegateInput>({
      additionalProperties: false,
      properties: {
        prompt: {
          type: "string",
          description:
            "reader 에이전트에 전달할 작업 프롬프트. 반드시 단일 문자열이어야 한다.",
        },
      },
      required: ["prompt"],
      type: "object",
    }),
  });
}

async function runBlockingDelegation({
  abortSignal,
  prompt,
  readerAgent,
  threadKey,
}: {
  readonly abortSignal?: AbortSignal;
  readonly prompt: AgentInput;
  readonly readerAgent: Agent;
  readonly threadKey: string;
}) {
  const childThread = readerAgent.thread(threadKey);
  if (abortSignal?.aborted) {
    return {
      result: "aborted" as const,
      subagent: readerChildName,
      text: "",
    };
  }

  const abort = () => childThread.interrupt();
  abortSignal?.addEventListener("abort", abort, { once: true });
  try {
    const text = await collectAssistantText(await childThread.send(prompt));
    return {
      result: "completed" as const,
      subagent: readerChildName,
      text,
    };
  } finally {
    abortSignal?.removeEventListener("abort", abort);
  }
}

async function collectAssistantText(run: AgentRun) {
  let text = "";
  for await (const event of run.events()) {
    if (event.type === "assistant-text") {
      text += event.text;
    }
  }
  return text;
}
