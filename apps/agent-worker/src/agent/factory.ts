import { Agent, type AgentHost } from "@minpeter/pss-runtime";
import {
  createCloudflareDurableObjectHost,
  type CloudflareDurableObjectStorage,
} from "@minpeter/pss-runtime/cloudflare";
import {
  createLanguageModel,
  type AgentWorkerBindings,
} from "./config";
import executionAgentInstructions from "./execution_agent_instructions.md";
import interactionAgentInstructions from "./interaction_agent_instructions.md";
import {
  createPokeTagsPlugin,
  createUserTagsPlugin,
} from "./message-tags-plugin";
import {
  createTelegramUxTools,
  type TelegramUxContext,
} from "../telegram/ux-tools";

export interface CreateChatAgentOptions {
  readonly host?: AgentHost;
  readonly telegramUx?: TelegramUxContext;
}

export function createExecutionAgent(
  host: AgentHost,
  bindings: AgentWorkerBindings
): Agent {
  return new Agent({
    host,
    instructions: executionAgentInstructions,
    model: createLanguageModel(bindings),
    name: "execution",
    namespace: "execution",
    plugins: [createPokeTagsPlugin()],
  });
}

export function createChatAgent(
  storage: CloudflareDurableObjectStorage,
  storePrefix: string,
  bindings: AgentWorkerBindings,
  options?: CreateChatAgentOptions
): Agent {
  const resolvedHost =
    options?.host ??
    createCloudflareDurableObjectHost({
      prefix: storePrefix,
      storage,
    });
  const telegramTools =
    options?.telegramUx === undefined
      ? undefined
      : createTelegramUxTools(options.telegramUx);

  return new Agent({
    host: resolvedHost,
    instructions: interactionAgentInstructions,
    model: createLanguageModel(bindings),
    namespace: "telegram-chat",
    plugins: [createUserTagsPlugin()],
    tools: telegramTools,
    subagents: [
      {
        delegateToolName: "sendmessageto_agent",
        description:
          "Executes tasks for Bori: search, email, calendar, integrations, and browser work.",
        agent: createExecutionAgent(resolvedHost, bindings),
        name: "execution",
      },
    ],
  });
}