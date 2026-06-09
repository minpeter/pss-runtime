import type { AgentEvent } from "@minpeter/pss-runtime";
import {
  type CloudflareDurableObjectStorage,
  drainAgentRun,
} from "@minpeter/pss-runtime/cloudflare";
import type { AgentWorkerBindings } from "../agent/config";
import { createChatAgent } from "../agent/factory";
import { matchesDebugResetCommand, matchesHelpCommand } from "./commands";
import { assistantTextFromEvents } from "./events";
import {
  debugResetConfirmation,
  helpMarkdown,
  telegramMarkdownMessage,
} from "./replies";
import { telegramReplyBubbles } from "./reply-segments";
import { writeTelegramRoute } from "./route-store";
import { sessionKeyForThread, storePrefixForThread } from "./session";
import { toTelegramUxContext } from "./ux-tools";

export interface TelegramMessageLike {
  readonly author: {
    readonly fullName: string;
    readonly userId: string;
    readonly userName: string;
  };
  readonly id: string;
  readonly text: string;
}

export interface TelegramThreadLike {
  addReaction(emoji: string): Promise<void>;
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

export async function handleTelegramMessage(
  options: HandleTelegramMessageOptions
): Promise<void> {
  const text = options.message.text.trim();
  if (!text) {
    return;
  }

  if (matchesHelpCommand(text)) {
    await options.thread.post({ markdown: helpMarkdown() });
    return;
  }

  if (matchesDebugResetCommand(text)) {
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
    await agent.session(sessionKey).delete();
    await options.thread.post(debugResetConfirmation());
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
  await writeTelegramRoute(options.storage, {
    chatId: options.thread.id,
    sessionKey,
    storePrefix,
    userId: options.message.author.userId,
  });
  const agent = createChatAgent(
    options.storage,
    storePrefix,
    options.bindings,
    {
      telegramUx: toTelegramUxContext(options.thread, options.message.id),
    }
  );
  const events = await drainAgentRun(
    await agent.session(sessionKey).send(text),
    {
      onEvent: (event: AgentEvent) => {
        console.log(event.type, event);
      },
    }
  );
  const reply = assistantTextFromEvents(events);
  if (!reply) {
    return;
  }
  for (const bubble of telegramReplyBubbles(reply)) {
    await options.thread.post(telegramMarkdownMessage(bubble));
  }
}
