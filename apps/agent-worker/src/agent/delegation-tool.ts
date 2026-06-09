import {
  delegateUserInput,
  type Agent,
  type ExecutionHost,
} from "@minpeter/pss-runtime";
import { jsonSchema, tool } from "ai";
import {
  backgroundLaunchOutput,
  defaultChildSessionKey,
  launchDurableBackgroundDelegation,
} from "./background-delegation";

const delegateToolName = "sendmessageto_agent";
const executionChildName = "execution";

interface DelegateInput {
  readonly description?: string;
  readonly prompt: string;
}

export interface CreateSendMessageToAgentToolOptions {
  readonly executionAgent: Agent;
  readonly executionHost: ExecutionHost;
  readonly parentAgentNamespace: string;
  readonly parentSessionKey: string;
}

export function createSendMessageToAgentTool(
  options: CreateSendMessageToAgentToolOptions
) {
  return tool<DelegateInput, unknown, Record<string, unknown>>({
    description:
      "Delegate work to execution: Executes delegated tasks for Bori. Currently: web search and page fetch.",
    execute: async (input, { abortSignal, toolCallId }) => {
      if (abortSignal?.aborted) {
        throw new Error("Delegation was aborted before it started.");
      }

      const prompt = delegateUserInput(input.prompt, { delegateToolName });
      const sessionKey = defaultChildSessionKey(
        options.parentAgentNamespace,
        options.parentSessionKey,
        executionChildName
      );

      const job = await launchDurableBackgroundDelegation({
        delegateToolCallId: toolCallId,
        description: input.description,
        executionHost: options.executionHost,
        ownerNamespace: options.parentAgentNamespace,
        parentSessionKey: options.parentSessionKey,
        prompt,
        sessionKey,
        subagent: executionChildName,
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
            'Task prompt for the delegated agent. Must be a single plain string, not an object or array. Example: "Search for hashed vc".',
        },
      },
      required: ["prompt"],
      type: "object",
    }),
  });
}