import { AsyncLocalStorage } from "node:async_hooks";

import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { fetchCloudflareDurableObject } from "@minpeter/pss-runtime/platform/cloudflare";
import { Chat, type Message, type MessageContext, type Thread } from "chat";
import { z } from "zod";

import type { AgentRequestAttachment } from "./agent-do-request";
import { type ChannelAddress, channelKey } from "./channel";
import {
  durableObjectName,
  type Env,
  isDevelopment,
  readWebhookSecretToken,
} from "./env";
import { workerErrors } from "./worker-errors";
import { logError, logWarn, newCorrelationId } from "./worker-log";

const correlationStore = new AsyncLocalStorage<string>();

const DEV_NOTICE = "🧪 DEVELOPMENT ENVIRONMENT";
const FAILURE_REPLY =
  "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
const MISSING_SEND_MESSAGE_ERROR = "missing_send_message";
const DEFAULT_IMAGE_MEDIA_TYPE = "image/jpeg";
const AgentDeliverySchema = z.discriminatedUnion("delivered", [
  z.object({ delivered: z.literal(true) }).strict(),
  z
    .object({
      delivered: z.literal(false),
      error: z.literal(MISSING_SEND_MESSAGE_ERROR),
    })
    .strict(),
]);

let cachedBot: CachedBot | undefined;

interface TurnDeliveryOptions {
  readonly attachments?: readonly AgentRequestAttachment[];
  readonly correlationId?: string;
  readonly sessionScopeKey?: string;
}

type TurnDeliverer = (
  channelId: string,
  text: string,
  options?: TurnDeliveryOptions
) => Promise<void>;

interface ConversationEnv {
  readonly ENVIRONMENT: Env["ENVIRONMENT"];
}

interface ConversationAttachment {
  readonly data?: ArrayBuffer | Blob | Uint8Array;
  readonly fetchData?: () => Promise<ArrayBuffer | Blob | Uint8Array>;
  readonly mimeType?: string;
  readonly name?: string;
  readonly type: "audio" | "file" | "image" | "video";
}

interface ConversationMessage {
  readonly attachments?: readonly ConversationAttachment[];
  readonly author?: {
    readonly userId?: string;
  };
  readonly text?: string;
}

interface ConversationContext {
  readonly skipped: readonly ConversationMessage[];
}

interface ConversationThread {
  readonly channelId: string;
  post(message: string): Promise<unknown>;
  subscribe(): Promise<unknown>;
}

interface BotConfig {
  readonly agentNamespace: DurableObjectNamespace;
  readonly botToken: string;
  readonly environment: Env["ENVIRONMENT"];
  readonly secretToken: string;
  readonly userName: string;
}

interface CachedBot {
  readonly bot: Chat;
  readonly config: BotConfig;
}

function createBot(env: Env, config: BotConfig): Chat {
  const chat = new Chat({
    concurrency: "queue",
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

  const handleMessage = async (
    thread: Thread,
    message: Message,
    context: MessageContext | undefined,
    options?: { readonly subscribe?: boolean }
  ) =>
    replyToThread({
      env,
      context,
      deliverTurn: (channelId, text, options) =>
        requestAgentDelivery(env, channelId, text, options),
      message,
      subscribe: options?.subscribe ?? false,
      thread,
    });

  chat.onDirectMessage(async (thread, message, _channel, context) => {
    await handleMessage(thread, message, context);
  });
  chat.onNewMention(async (thread, message, context) => {
    await handleMessage(thread, message, context, { subscribe: true });
  });
  chat.onSubscribedMessage(async (thread, message, context) => {
    await handleMessage(thread, message, context);
  });

  return chat;
}

export function collectTurnText(
  message: ConversationMessage,
  context?: ConversationContext
): string {
  return [...(context?.skipped ?? []), message]
    .map((item) => item.text)
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

/** Image attachments on the latest message only (skipped queue is text-only). */
export async function collectTurnImageAttachments(
  message: ConversationMessage
): Promise<readonly AgentRequestAttachment[]> {
  const attachments = message.attachments ?? [];
  const images: AgentRequestAttachment[] = [];

  for (const attachment of attachments) {
    if (!isImageAttachment(attachment)) {
      continue;
    }

    const bytes = await readAttachmentBytes(attachment);
    if (!bytes || bytes.byteLength === 0) {
      logWarn({
        action: "attachment_empty",
        scope: "telegram",
      });
      continue;
    }

    images.push({
      dataBase64: bytesToBase64(bytes),
      mediaType: imageMediaType(attachment),
      ...(attachment.name?.trim() ? { filename: attachment.name.trim() } : {}),
    });
  }

  return images;
}

export function isImageAttachment(attachment: ConversationAttachment): boolean {
  if (attachment.type === "image") {
    return true;
  }
  if (attachment.type !== "file") {
    return false;
  }
  const mime = attachment.mimeType?.trim().toLowerCase() ?? "";
  return mime.startsWith("image/");
}

export async function replyToThread({
  context,
  deliverTurn,
  env,
  message,
  subscribe,
  thread,
}: {
  readonly context?: MessageContext;
  readonly deliverTurn: TurnDeliverer;
  readonly env: ConversationEnv;
  readonly message: ConversationMessage;
  readonly subscribe?: boolean;
  readonly thread: ConversationThread;
}): Promise<void> {
  const text = collectTurnText(message, context);
  let attachments: readonly AgentRequestAttachment[] = [];
  try {
    attachments = await collectTurnImageAttachments(message);
  } catch (error) {
    logError(
      workerErrors.ATTACHMENT_FETCH_FAILED({ cause: normalizeError(error) }),
      { scope: "telegram" }
    );
    await thread.post(FAILURE_REPLY);
    return;
  }

  if (!(text || attachments.length > 0)) {
    return;
  }

  try {
    if (subscribe) {
      await thread.subscribe();
    }
    if (isDevelopment(env)) {
      await thread.post(DEV_NOTICE);
    }

    await deliverTurn(thread.channelId, text, {
      attachments,
      sessionScopeKey: telegramSessionScopeKey(message),
    });
  } catch (error) {
    logError(
      workerErrors.TELEGRAM_HANDLER_FAILED({ cause: normalizeError(error) }),
      { scope: "telegram" }
    );
    await thread.post(FAILURE_REPLY);
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(`Non-Error thrown: ${String(error)}`);
}

export async function requestAgentDelivery(
  env: Env,
  channelId: string,
  text: string,
  options: TurnDeliveryOptions = {}
): Promise<void> {
  const channel: ChannelAddress = { id: channelId, kind: "telegram" };
  const sessionScopeKey = options.sessionScopeKey?.trim();
  const correlationId =
    options.correlationId?.trim() ||
    correlationStore.getStore() ||
    newCorrelationId();
  const attachments = options.attachments ?? [];
  const response = await fetchCloudflareDurableObject({
    namespace: env.AGENT_DO,
    objectName: durableObjectName(channelKey(channel)),
    request: new Request("https://agent.internal/turn", {
      body: JSON.stringify({
        channel,
        correlationId,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(sessionScopeKey ? { sessionScopeKey } : {}),
        text,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  });

  if (!response?.ok) {
    throw new Error(
      `agent durable object failed: ${response?.status ?? "missing"}`
    );
  }

  const payload = AgentDeliverySchema.parse(await response.json());
  if (payload.delivered) {
    return;
  }

  throw workerErrors.MISSING_SEND_MESSAGE();
}

function telegramSessionScopeKey(
  message: ConversationMessage
): string | undefined {
  const userId = message.author?.userId?.trim();
  return userId ? `telegram:user:${userId}` : undefined;
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
  return correlationStore.run(correlationId, () =>
    bot.bot.webhooks.telegram(request, {
      waitUntil: (task) => ctx.waitUntil(task),
    })
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

function imageMediaType(attachment: ConversationAttachment): string {
  const mime = attachment.mimeType?.trim();
  if (mime) {
    return mime;
  }
  return DEFAULT_IMAGE_MEDIA_TYPE;
}

async function readAttachmentBytes(
  attachment: ConversationAttachment
): Promise<Uint8Array | undefined> {
  if (attachment.data !== undefined) {
    return coerceBytes(attachment.data);
  }
  if (attachment.fetchData) {
    return coerceBytes(await attachment.fetchData());
  }
  return;
}

async function coerceBytes(
  value: ArrayBuffer | Blob | Uint8Array
): Promise<Uint8Array> {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new Uint8Array(await value.arrayBuffer());
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x80_00;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
