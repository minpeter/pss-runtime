import { type Agent, createAgent } from "@minpeter/pss-runtime";
import { parentThreadNamespace } from "@minpeter/pss-runtime/namespace";
import type { LanguageModel } from "ai";
import { createConversationHooks } from "./conversation-hooks";
import { createDelegateToReaderTool } from "./delegate-tool";
import { createReadFileTool } from "./read-file-tool";

export async function createReaderAgent(model: LanguageModel) {
  return await createAgent({
    instructions:
      "fixtures/kb/ Document read_fileRead only the files associated with the request, and be sure to write down the path to the file based on your response..",
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
    readonly readerAgent: Agent;
    readonly threadKey: string;
  }
) {
  const coordinatorNamespace = "coordinator";

  return await createAgent({
    instructions:
      "Coordinate conversations. Knowledge base lookups readerTO delegate_to_readerand delegate it to, readerForward the file path quoted by to the user.",
    model,
    namespace: coordinatorNamespace,
    hooks: createConversationHooks(),
    tools: {
      delegate_to_reader: createDelegateToReaderTool({
        description:
          "Read the knowledgebase article. reader Delegate to agents.",
        parentAgentNamespace: parentThreadNamespace(
          coordinatorNamespace,
          options.threadKey
        ),
        parentThreadKey: options.threadKey,
        readerAgent: options.readerAgent,
      }),
    },
  });
}
