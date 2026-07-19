import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { Chat, type Message, type MessageContext, type Thread } from "chat";

import type { Env } from "./env";
import {
  isTelegramIngressDryRun,
  readWebhookSecretToken,
} from "./env";
import { TELEGRAM_INGRESS_LAYER } from "./message-path-layers";
import { requestAgentDelivery, replyToThread } from "./telegram-delivery";
import {
  formatIngressDryRunReply,
  summarizeIngressBatch,
} from "./telegram-ingress";
import {
  createMessageCoalescer,
  MissingWaitUntilError,
} from "./telegram-message-coalesce";
import type {
  BotConfig,
  CachedBot,
  ConversationMessage,
  ConversationThread,
} from "./telegram-types";
import {
  correlationStore,
  TELEGRAM_COALESCE_QUIET_MS,
  TELEGRAM_MESSAGE_CONCURRENCY,
  waitUntilStore,
} from "./telegram-types";
import { logError, logInfo, newCorrelationId } from "./worker-log";

let cachedBot: CachedBot | undefined;

function createBot(env: Env, config: BotConfig): Chat {
  const chat = new Chat({
    concurrency: TELEGRAM_MESSAGE_CONCURRENCY,
    adapters: {
      telegram: createTelegramAdapter({
        botToken: config.botToken,
        mode: "webhook",
        secretToken: config.secretToken,
        userName: config.userName,
      }),
    },
    state: createMemoryState(),
    userName: config.userName,
  });

  const threadsByKey = new Map<string, ConversationThread>();
  const ingressCoalescer = createMessageCoalescer<ConversationMessage>({
    quietMs: TELEGRAM_COALESCE_QUIET_MS,
    onFlush: async (key, batch) => {
      const thread = threadsByKey.get(key);
      if (!thread) {
        throw new Error(`Missing telegram thread for coalesce key ${key}`);
      }
      const latest = batch.messages.at(-1);
      if (!latest) {
        return;
      }

      const summary = summarizeIngressBatch(batch.messages, {
        correlationId: batch.correlationId,
        key,
        subscribe: batch.subscribe,
      });
      logInfo({
        message: "telegram-ingress flush",
        layer: TELEGRAM_INGRESS_LAYER,
        dryRun: isTelegramIngressDryRun(env),
        ...summary,
      });

      if (isTelegramIngressDryRun(env)) {
        await thread.post(formatIngressDryRunReply(summary));
        return;
      }

      await replyToThread({
        env,
        batchMessages: batch.messages,
        context: { skipped: batch.messages.slice(0, -1) },
        correlationId: batch.correlationId,
        deliverTurn: (channelId, text, options) =>
          requestAgentDelivery(env, channelId, text, {
            ...options,
            ...(batch.correlationId
              ? { correlationId: batch.correlationId }
              : {}),
          }),
        message: latest,
        subscribe: batch.subscribe,
        thread,
      });
    },
    onFlushError: (key, error, batch) => {
      logError(normalizeError(error), {
        action: "ingress_fragment_flush_failed",
        layer: TELEGRAM_INGRESS_LAYER,
        scope: "telegram",
        key,
        messageCount: batch.messages.length,
        ...(batch.correlationId ? { correlationId: batch.correlationId } : {}),
      });
    },
  });

  const handleMessage = (
    thread: Thread,
    message: Message,
    _context: MessageContext | undefined,
    options?: { readonly subscribe?: boolean }
  ): void => {
    const key = message.threadId || thread.id || thread.channelId;
    threadsByKey.set(key, thread);
    const waitUntil = waitUntilStore.getStore();
    if (!waitUntil) {
      logError(new MissingWaitUntilError(), {
        action: "ingress_missing_wait_until",
        layer: TELEGRAM_INGRESS_LAYER,
        scope: "telegram",
        key,
      });
      return;
    }
    ingressCoalescer.enqueue(
      key,
      {
        correlationId: correlationStore.getStore(),
        message: asConversationMessage(message),
        subscribe: options?.subscribe,
      },
      { waitUntil }
    );
  };

  chat.onDirectMessage((thread, message, _channel, context) => {
    handleMessage(thread, message, context);
  });
  chat.onNewMention((thread, message, context) => {
    handleMessage(thread, message, context, { subscribe: true });
  });
  chat.onSubscribedMessage((thread, message, context) => {
    handleMessage(thread, message, context);
  });

  return chat;
}

export function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: { readonly correlationId?: string } = {}
): Promise<Response> {
  const config = readBotConfig(env);
  if (!(cachedBot && isSameBotConfig(cachedBot.config, config))) {
    cachedBot = { bot: createBot(env, config), config };
  }
  const correlationId = options.correlationId?.trim() || newCorrelationId();
  const bot = cachedBot;
  if (!bot) {
    throw new Error("Telegram bot cache was not initialized.");
  }
  const waitUntil = (task: Promise<unknown>) => {
    ctx.waitUntil(task);
  };
  return correlationStore.run(correlationId, () =>
    waitUntilStore.run(waitUntil, () =>
      bot.bot.webhooks.telegram(request, { waitUntil })
    )
  );
}

function readBotConfig(env: Env): BotConfig {
  return {
    agentNamespace: env.AGENT_DO,
    botToken: env.TELEGRAM_BOT_TOKEN,
    environment: env.ENVIRONMENT,
    secretToken: readWebhookSecretToken(env),
    userName: env.TELEGRAM_BOT_USERNAME?.trim() || "pss_echo_bot",
  };
}

function isSameBotConfig(left: BotConfig, right: BotConfig): boolean {
  return (
    left.agentNamespace === right.agentNamespace &&
    left.botToken === right.botToken &&
    left.environment === right.environment &&
    left.secretToken === right.secretToken &&
    left.userName === right.userName
  );
}

function asConversationMessage(message: Message): ConversationMessage {
  return message;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(`Non-Error thrown: ${String(error)}`);
}

export {
  collectTurnImageAttachments,
  collectTurnImages,
  isImageAttachment,
  TelegramAttachmentLimitError,
} from "./telegram-attachments";
export { replyToThread, requestAgentDelivery } from "./telegram-delivery";
export {
  collectTurnText,
  collectTurnTexts,
  formatIngressDryRunReply,
  summarizeIngressBatch,
} from "./telegram-ingress";
export type { IngressBatchSummary } from "./telegram-ingress";
export {
  TELEGRAM_COALESCE_QUIET_MS,
  TELEGRAM_MAX_RAW_IMAGE_BYTES,
  TELEGRAM_MAX_TURN_IMAGES,
  TELEGRAM_MAX_TURN_RAW_IMAGE_BYTES,
  TELEGRAM_MESSAGE_CONCURRENCY,
} from "./telegram-types";
