import { Agent, executionHost, type AgentHost } from "@minpeter/pss-runtime";
import {
  type CloudflareDurableObjectStorage,
  createCloudflareDurableObjectHost,
} from "@minpeter/pss-runtime/cloudflare";
import { createWebTools } from "@minpeter/pss-web-tools";
import { readWorkerWebToolsEnv } from "@minpeter/pss-web-tools/env";
import {
  createTelegramUxTools,
  type TelegramUxContext,
} from "../telegram/ux-tools";
import { type AgentWorkerBindings, createLanguageModel } from "./config";
import { createSendMessageToAgentTool } from "./delegation-tool";
import executionAgentInstructions from "./execution_agent_instructions.md";
import interactionAgentInstructions from "./interaction_agent_instructions.md";
import {
  createPokeTagsPlugin,
  createUserTagsPlugin,
} from "./message-tags-plugin";
import { chatParentSessionNamespace } from "./namespace";

export interface CreateChatAgentOptions {
  readonly host?: AgentHost;
  readonly sessionKey?: string;
  readonly telegramUx?: TelegramUxContext;
}

export function createExecutionAgent(
  host: AgentHost,
  bindings: AgentWorkerBindings
): Agent {
  const { tools } = createWebTools({
    env: readWorkerWebToolsEnv({ EXA_API_KEY: bindings.EXA_API_KEY }),
  });

  return new Agent({
    host,
    instructions: executionAgentInstructions,
    model: createLanguageModel(bindings),
    namespace: "execution",
    plugins: [createPokeTagsPlugin()],
    tools,
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
  const executionAgent = createExecutionAgent(resolvedHost, bindings);
  const hostExecution = executionHost(resolvedHost);
  const delegationTools =
    options?.sessionKey && hostExecution
      ? {
          sendmessageto_agent: createSendMessageToAgentTool({
            executionAgent,
            executionHost: hostExecution,
            parentAgentNamespace: chatParentSessionNamespace(
              options.sessionKey
            ),
            parentSessionKey: options.sessionKey,
          }),
        }
      : undefined;

  return new Agent({
    host: resolvedHost,
    instructions: interactionAgentInstructions,
    model: createLanguageModel(bindings),
    namespace: "telegram-chat",
    plugins: [createUserTagsPlugin()],
    tools:
      delegationTools || telegramTools
        ? {
            ...delegationTools,
            ...telegramTools,
          }
        : undefined,
  });
}