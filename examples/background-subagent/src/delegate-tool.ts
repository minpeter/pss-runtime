import { delegateUserInput } from "@minpeter/pss-runtime";
import type { AgentHost } from "@minpeter/pss-runtime/execution";
import { defaultChildThreadKey } from "@minpeter/pss-runtime/namespace";
import { jsonSchema, tool } from "ai";
import {
  backgroundLaunchOutput,
  launchDurableBackgroundDelegation,
} from "./background-delegation";

export const delegateToolName = "delegate_to_reader";
export const readerChildName = "reader";

interface DelegateInput {
  readonly description?: string;
  readonly prompt: string;
}

export function createDelegateToReaderTool(options: {
  readonly description: string;
  readonly executionHost: AgentHost;
  readonly parentAgentNamespace: string;
  readonly parentThreadKey: string;
}) {
  return tool<DelegateInput, unknown, Record<string, unknown>>({
    description: options.description,
    execute: async (input, { abortSignal, toolCallId }) => {
      if (abortSignal?.aborted) {
        throw new Error("Delegation was aborted before it started.");
      }

      const prompt = delegateUserInput(input.prompt);
      const childThreadKey = defaultChildThreadKey(
        options.parentAgentNamespace,
        options.parentThreadKey,
        readerChildName
      );

      const job = await launchDurableBackgroundDelegation({
        delegateToolCallId: toolCallId,
        description: input.description,
        executionHost: options.executionHost,
        ownerNamespace: options.parentAgentNamespace,
        parentThreadKey: options.parentThreadKey,
        prompt,
        threadKey: childThreadKey,
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
            "Task prompt to forward to the reader agent. Must be a single string.",
        },
      },
      required: ["prompt"],
      type: "object",
    }),
  });
}
