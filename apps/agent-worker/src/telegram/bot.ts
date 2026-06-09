import {
  createTelegramAdapter,
  type TelegramAdapterConfig,
} from "@chat-adapter/telegram";
import type { CloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";
import { Chat, ConsoleLogger, type Message, type Thread } from "chat";
import {
  type AgentWorkerBindings,
  parseAgentWorkerBindings,
} from "../agent/config";
import { handleTelegramMessage, type TelegramThreadLike } from "./handler";
import { createDurableObjectStateAdapter } from "./state-adapter";
import { resolveTelegramWebhookSecret } from "./webhook-secret";

const userName = "pss_agent";

export interface TelegramBotEnv extends AgentWorkerBindings {}

export interface TelegramWebhookBot {
  handleWebhook(
    request: Request,
    options?: { readonly waitUntil?: (task: Promise<unknown>) => void }
  ): Promise<Response>;
}

export class MissingTelegramConfigError extends Error {
  readonly variableName: string;

  constructor(variableName: string) {
    super(`${variableName} is required for Telegram.`);
    this.name = "MissingTelegramConfigError";
    this.variableName = variableName;
  }
}

export function createTelegramWebhookBot(options: {
  readonly bindings: TelegramBotEnv;
  readonly storage: CloudflareDurableObjectStorage;
}): TelegramWebhookBot {
  const bindings = parseAgentWorkerBindings(options.bindings);
  const botToken = readEnv(bindings.TELEGRAM_BOT_TOKEN);
  if (!botToken) {
    throw new MissingTelegramConfigError("TELEGRAM_BOT_TOKEN");
  }

  const { bot } = createTelegramChat({
    bindings,
    storage: options.storage,
    secretToken: resolveTelegramWebhookSecret({
      botToken,
      webhookSecret: bindings.TELEGRAM_WEBHOOK_SECRET,
    }),
  });

  return {
    handleWebhook: async (request, webhookOptions) =>
      await bot.webhooks.telegram(request, webhookOptions),
  };
}

function createTelegramChat(options: {
  readonly bindings: AgentWorkerBindings;
  readonly secretToken: string;
  readonly storage: CloudflareDurableObjectStorage;
}): {
  readonly bot: Chat<{
    readonly telegram: ReturnType<typeof createTelegramAdapter>;
  }>;
} {
  const botToken = readEnv(options.bindings.TELEGRAM_BOT_TOKEN);
  if (!botToken) {
    throw new MissingTelegramConfigError("TELEGRAM_BOT_TOKEN");
  }

  const telegram = createTelegramAdapter(
    telegramConfig(botToken, options.secretToken)
  );
  const adapters = { telegram };
  const bot = new Chat({
    adapters,
    concurrency: "queue",
    logger: "silent",
    state: createDurableObjectStateAdapter(options.storage),
    userName,
  });
  const handler = async (thread: Thread, message: Message): Promise<void> => {
    try {
      const telegramThread: TelegramThreadLike = {
        id: thread.id,
        async addReaction(emoji: string) {
          await thread.adapter.addReaction(thread.id, message.id, emoji);
        },
        post: (content) => thread.post(content),
        startTyping: (status) => thread.startTyping(status),
      };
      await handleTelegramMessage({
        bindings: options.bindings,
        message: {
          author: message.author,
          id: message.id,
          text: message.text,
        },
        storage: options.storage,
        thread: telegramThread,
      });
    } catch (error) {
      if (error instanceof Error) {
        console.error(error);
        await thread.post(`Handler failed: ${error.name}: ${error.message}`);
        return;
      }
      throw error;
    }
  };

  bot.onDirectMessage(handler);

  return { bot };
}

function telegramConfig(
  botToken: string,
  secretToken: string
): TelegramAdapterConfig {
  return {
    botToken,
    logger: new ConsoleLogger("info"),
    mode: "webhook",
    secretToken,
    userName,
  };
}

function readEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
