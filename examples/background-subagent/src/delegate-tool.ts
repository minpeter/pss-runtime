import { delegateUserInput } from "@minpeter/pss-runtime";
import type { ExecutionHost } from "@minpeter/pss-runtime/execution";
import { jsonSchema, tool } from "ai";
import {
  backgroundLaunchOutput,
  defaultChildSessionKey,
  launchDurableBackgroundDelegation,
} from "./background-delegation";

export const delegateToolName = "delegate_to_reader";
export const readerChildName = "reader";

interface DelegateInput {
  readonly description?: string;
  readonly prompt: string;
}

export function parentSessionNamespace(
  agentNamespace: string,
  sessionKey: string
): string {
  const sessionNamespace = `agent:${encodeURIComponent(agentNamespace)}`;
  return `${sessionNamespace}:session:${encodeURIComponent(sessionKey)}:generation:0`;
}

export function createDelegateToReaderTool(options: {
  readonly description: string;
  readonly executionHost: ExecutionHost;
  readonly parentAgentNamespace: string;
  readonly parentSessionKey: string;
}) {
  return tool<DelegateInput, unknown, Record<string, unknown>>({
    description: options.description,
    execute: async (input, { abortSignal, toolCallId }) => {
      if (abortSignal?.aborted) {
        throw new Error("Delegation was aborted before it started.");
      }

      const prompt = delegateUserInput(input.prompt, { delegateToolName });
      const childSessionKey = defaultChildSessionKey(
        options.parentAgentNamespace,
        options.parentSessionKey,
        readerChildName
      );

      const job = await launchDurableBackgroundDelegation({
        delegateToolCallId: toolCallId,
        description: input.description,
        executionHost: options.executionHost,
        ownerNamespace: options.parentAgentNamespace,
        parentSessionKey: options.parentSessionKey,
        prompt,
        sessionKey: childSessionKey,
        subagent: readerChildName,
      });

      return backgroundLaunchOutput(job);
    },
    inputSchema: jsonSchema<DelegateInput>({
      additionalProperties: false,
      properties: {
        description: { type: "string" },
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