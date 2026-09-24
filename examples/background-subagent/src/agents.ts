import { type AgentHost, createAgent } from "@minpeter/pss-runtime";
import { parentThreadNamespace } from "@minpeter/pss-runtime/namespace";
import type { LanguageModel } from "ai";
import { createBackgroundOutputTool } from "./background-output-tool";
import { createConversationHooks } from "./conversation-hooks";
import { createDelegateToReaderTool } from "./delegate-tool";
import { createReadFileTool } from "./read-file-tool";

export async function createReaderAgent(model: LanguageModel, host: AgentHost) {
  return await createAgent({
    host,
    instructions:
      "Read documents in fixtures/kb/ with read_file. Read only files relevant to the request, and always cite the source file paths in your response.",
    model,
    namespace: "reader",
    tools: {
      read_file: createReadFileTool(),
    },
  });
}

export async function createCoordinatorAgent(
  model: LanguageModel,
  options: {
    readonly executionHost: AgentHost;
    readonly host: AgentHost;
    readonly threadKey: string;
  }
) {
  const coordinatorNamespace = "coordinator";

  return await createAgent({
    host: options.host,
    instructions: [
      "Coordinate the conversation.",
      "Delegate knowledge-base lookups to the reader agent in the background with delegate_to_reader.",
      "After receiving a task_id, you can continue the conversation without waiting for the task to complete.",
      "Do not call background_output until receiving a <system-reminder>.",
      "After notification, retrieve the result with background_output({ task_id, block: true }) and summarize it, including the file paths cited by the reader.",
    ].join(" "),
    model,
    namespace: coordinatorNamespace,
    hooks: createConversationHooks(),
    tools: {
      background_output: createBackgroundOutputTool({
        executionHost: options.executionHost,
        ownerNamespace: parentThreadNamespace(
          coordinatorNamespace,
          options.threadKey
        ),
        parentThreadKey: options.threadKey,
      }),
      delegate_to_reader: createDelegateToReaderTool({
        description:
          "Delegate knowledge-base document reading to the reader agent in the background.",
        executionHost: options.executionHost,
        parentAgentNamespace: parentThreadNamespace(
          coordinatorNamespace,
          options.threadKey
        ),
        parentThreadKey: options.threadKey,
      }),
    },
  });
}
