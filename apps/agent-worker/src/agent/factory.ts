import { Agent } from "@minpeter/pss-runtime";
import {
  createCloudflareDurableObjectHost,
  type CloudflareDurableObjectStorage,
} from "@minpeter/pss-runtime/cloudflare";
import {
  createLanguageModel,
  type AgentWorkerBindings,
} from "./config";

export function createChatAgent(
  storage: CloudflareDurableObjectStorage,
  storePrefix: string,
  bindings: AgentWorkerBindings
): Agent {
  const host = createCloudflareDurableObjectHost({
    prefix: storePrefix,
    storage,
  });

  return new Agent({
    host,
    instructions:
      "You are a helpful assistant in a Telegram chat. Be concise, accurate, and conversational.",
    model: createLanguageModel(bindings),
    namespace: "telegram-chat",
  });
}