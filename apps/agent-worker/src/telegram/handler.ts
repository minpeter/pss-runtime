import type { AgentEvent } from "@minpeter/pss-runtime";
import {
  drainAgentRun,
  type CloudflareDurableObjectStorage,
} from "@minpeter/pss-runtime/cloudflare";
import type { AgentWorkerBindings } from "../agent/config";
import { createChatAgent } from "../agent/factory";
import { assistantTextFromEvents } from "./events";
import { helpMarkdown } from "./replies";
import { sessionKeyForThread, storePrefixForThread } from "./session";

export interface TelegramMessageLike {
  readonly author: {
    readonly fullName: string;
    readonly userId: string;
    readonly userName: string;
  };
  readonly text: string;
}

export interface TelegramThreadLike {
  readonly id: string;
  post(message: string | { readonly markdown: string }): Promise<unknown>;
  startTyping(status?: string): Promise<unknown>;
}

export interface HandleTelegramMessageOptions {
  readonly bindings: AgentWorkerBindings;
  readonly message: TelegramMessageLike;
  readonly storage: CloudflareDurableObjectStorage;
  readonly thread: TelegramThreadLike;
}

const helpPattern = /^\/(?:start|help)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;

export async function handleTelegramMessage(
  options: HandleTelegramMessageOptions
): Promise<void> {
  const text = options.message.text.trim();
  if (!text) {
    return;
  }

  if (helpPattern.test(text)) {
    await options.thread.post({ markdown: helpMarkdown() });
    return;
  }

  if (text.startsWith("/")) {
    await options.thread.post(
      "Unknown command. Send a plain message to chat, or use /help."
    );
    return;
  }

  await options.thread.startTyping();
  const storePrefix = storePrefixForThread(
    options.thread.id,
    options.message.author.userId
  );
  const sessionKey = sessionKeyForThread(
    options.thread.id,
    options.message.author.userId
  );
  const agent = createChatAgent(
    options.storage,
    storePrefix,
    options.bindings
  );
  const events = await drainAgentRun(
    await agent.session(sessionKey).send(text),
    {
      onEvent: (event: AgentEvent) => {
        console.log(event.type, event);
      },
    }
  );
  const reply = assistantTextFromEvents(events) ?? "No response generated.";
  await options.thread.post(reply);
}