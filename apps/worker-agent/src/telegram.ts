import { AsyncLocalStorage } from "node:async_hooks";

import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { fetchCloudflareDurableObject } from "@minpeter/pss-runtime/platform/cloudflare";
import { Chat, type Message, type MessageContext, type Thread } from "chat";
import { z } from "zod";

import type { AgentRequestAttachment } from "./agent-do-request";
import {
  AGENT_MAX_RAW_IMAGE_BYTES,
  AGENT_MAX_TURN_IMAGES,
  AGENT_MAX_TURN_RAW_IMAGE_BYTES,
} from "./attachment-limits";
import { type ChannelAddress, channelKey } from "./channel";
import {
  durableObjectName,
  type Env,
  isDevelopment,
  isTelegramIngressDryRun,
  readWebhookSecretToken,
} from "./env";
import { TELEGRAM_INGRESS_LAYER } from "./message-path-layers";
import {
  createMessageCoalescer,
  MissingWaitUntilError,
} from "./telegram-message-coalesce";
import { workerErrors } from "./worker-errors";
import { logError, logInfo, logWarn, newCorrelationId } from "./worker-log";

/**
 * Telegram webhook entry (Worker). Two layers — see message-path-layers.ts:
 *
 * 1. Layer 1 (`TELEGRAM_INGRESS_LAYER`): quiet-window fragment reassembly so
 *    chat-sdk/Telegram split updates become one forward message.
 * 2. Layer 2 (`AGENT_TURN_ADMISSION_LAYER`): lives on the DO — every
 *    reassembled message is delivered immediately (idle send / running steer).
 */
const correlationStore = new AsyncLocalStorage<string>();
/** Per-webhook waitUntil so Layer 1 quiet flush outlives the HTTP response. */
const waitUntilStore = new AsyncLocalStorage<
  (task: Promise<unknown>) => void
>();

const DEV_NOTICE = "🧪 DEVELOPMENT ENVIRONMENT";
const FAILURE_REPLY =
  "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
const MISSING_SEND_MESSAGE_ERROR = "missing_send_message";
const DEFAULT_IMAGE_MEDIA_TYPE = "image/jpeg";
/**
 * Layer 1 only — quiet window after the latest Telegram fragment before
 * flushing one reassembled user message to the agent.
 *
 * Resets on every fragment so text + a late photo still merge (chat-sdk's
 * own burst wait only runs once and cannot re-open for a late photo).
 *
 * 1200ms covers measured dual-update gaps (~0.75–0.85s) from Telegram
 * (forward photo + typed text as separate Message objects) without waiting
 * a full 1.5s after every quiet burst.
 *
 * This is NOT agent turn queueing; Layer 2 has no debounce.
 */
export const TELEGRAM_COALESCE_QUIET_MS = 1200;
/**
 * Layer 1 ingress: deliver every webhook fragment to our coalescer immediately
 * (strategy concurrent). App quiet window owns fragment reassembly; chat-sdk
 * must not also serialize/await agent turns.
 */
export const TELEGRAM_MESSAGE_CONCURRENCY = {
  strategy: "concurrent",
} as const;

/** Cap images per coalesced turn before base64 DO hop. */
export const TELEGRAM_MAX_TURN_IMAGES = AGENT_MAX_TURN_IMAGES;
/** Cap raw bytes per image before DO hop (compress still happens in DO). */
export const TELEGRAM_MAX_RAW_IMAGE_BYTES = AGENT_MAX_RAW_IMAGE_BYTES;
/** Cap total raw image bytes per coalesced turn before DO hop. */
export const TELEGRAM_MAX_TURN_RAW_IMAGE_BYTES = AGENT_MAX_TURN_RAW_IMAGE_BYTES;

/** Matches AgentDurableObject /turn JSON (`mode` from idle send / mid-turn steer). */
const AgentDeliverySchema = z.discriminatedUnion("delivered", [
  z
    .object({
      delivered: z.literal(true),
      mode: z.enum(["send", "steer"]).optional(),
      // Present on soft recoveries (e.g. AI Gateway timeout → user notice).
      outcome: z.string().optional(),
      messages: z
        .array(
          z
            .object({
              channel: z.string(),
              messageId: z.string(),
              text: z.string(),
            })
            .strict()
        )
        .readonly()
        .optional(),
    })
    .strict(),
  z
    .object({
      delivered: z.literal(false),
      error: z.literal(MISSING_SEND_MESSAGE_ERROR),
      mode: z.enum(["send", "steer"]).optional(),
      outcome: z.string().optional(),
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

  // Layer 1: reassemble Telegram fragments; flush hands one message to Layer 2.
  // Keep the last Thread handle per key — do not delete on flush. Concurrent
  // enqueue during a long flush races with delete and loses the handle
  // ("Missing telegram thread for coalesce key").
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

      // Layer 1 observability — what was reassembled (agent may be skipped).
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

      // Layer 1 only: verify reassembly without DO / model.
      if (isTelegramIngressDryRun(env)) {
        await thread.post(formatIngressDryRunReply(summary));
        return;
      }

      // Boundary: Layer 1 → Layer 2. DO admits with idle send / running steer.
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
    // Layer 1 only — never await agent here (Layer 2 is DO /turn admission).
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

export function collectTurnText(
  message: ConversationMessage,
  context?: ConversationContext
): string {
  return collectTurnTexts([...(context?.skipped ?? []), message]);
}

export function collectTurnTexts(
  messages: readonly ConversationMessage[]
): string {
  return messages
    .map((item) => item.text)
    .filter((text): text is string => Boolean(text))
    .join("\n");
}

export interface IngressBatchSummary {
  readonly correlationId?: string;
  /** True when at least one image attachment was present. */
  readonly hasImages: boolean;
  /** Exact count of image attachments (not messages). */
  readonly imageCount: number;
  /** Distinct media types among image attachments, e.g. image/jpeg. */
  readonly imageMediaTypes: readonly string[];
  readonly key: string;
  /** Webhook fragments merged into this quiet-window batch. */
  readonly messageCount: number;
  readonly subscribe: boolean;
  readonly textChars: number;
  readonly textPreview: string;
}

function isImageConversationAttachment(
  attachment: ConversationAttachment
): boolean {
  if (attachment.type === "image") {
    return true;
  }
  if (attachment.type !== "file") {
    return false;
  }
  return (
    attachment.mimeType?.trim().toLowerCase().startsWith("image/") ?? false
  );
}

/** Pure Layer 1 batch summary (no agent). Used for dry-run and logs. */
export function summarizeIngressBatch(
  messages: readonly ConversationMessage[],
  meta: {
    readonly correlationId?: string;
    readonly key: string;
    readonly subscribe: boolean;
  }
): IngressBatchSummary {
  const text = collectTurnTexts(messages);
  const imageMediaTypes: string[] = [];
  let imageCount = 0;
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (!isImageConversationAttachment(attachment)) {
        continue;
      }
      imageCount += 1;
      // Telegram photo objects often omit mime_type; chat-sdk leaves it empty.
      const mediaType =
        attachment.mimeType?.trim().toLowerCase() ||
        (attachment.type === "image" ? "image/jpeg" : "image/unknown");
      if (!imageMediaTypes.includes(mediaType)) {
        imageMediaTypes.push(mediaType);
      }
    }
  }
  const textPreview =
    text.length <= 80 ? text : `${text.slice(0, 77).trimEnd()}...`;
  return {
    key: meta.key,
    messageCount: messages.length,
    hasImages: imageCount > 0,
    imageCount,
    imageMediaTypes,
    subscribe: meta.subscribe,
    textChars: text.length,
    textPreview,
    ...(meta.correlationId ? { correlationId: meta.correlationId } : {}),
  };
}

export function formatIngressDryRunReply(summary: IngressBatchSummary): string {
  const imageLine = summary.hasImages
    ? `images=${summary.imageCount} types=[${summary.imageMediaTypes.join(", ")}]`
    : "images=0 (none attached)";
  const lines = [
    "🧪 ingress dry-run (Layer 1 only — agent skipped)",
    `fragments=${summary.messageCount} ${imageLine} textChars=${summary.textChars}`,
  ];
  if (summary.textPreview) {
    lines.push(`text: ${summary.textPreview}`);
  }
  if (summary.correlationId) {
    lines.push(`correlationId=${summary.correlationId}`);
  }
  return lines.join("\n");
}

/** Collect images from a single message (batch path uses collectTurnImages). */
export function collectTurnImageAttachments(
  message: ConversationMessage
): Promise<readonly AgentRequestAttachment[]> {
  return collectTurnImages([message]);
}

export class TelegramAttachmentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramAttachmentLimitError";
  }
}

export async function collectTurnImages(
  messages: readonly ConversationMessage[]
): Promise<readonly AgentRequestAttachment[]> {
  const images: AgentRequestAttachment[] = [];
  let totalRawBytes = 0;

  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      const next = await collectOneTurnImage(attachment, {
        count: images.length,
        totalRawBytes,
      });
      if (!next) {
        continue;
      }
      totalRawBytes += next.rawBytes;
      images.push(next.attachment);
    }
  }

  return images;
}

async function collectOneTurnImage(
  attachment: ConversationAttachment,
  budget: { readonly count: number; readonly totalRawBytes: number }
): Promise<
  | {
      readonly attachment: AgentRequestAttachment;
      readonly rawBytes: number;
    }
  | undefined
> {
  if (!isImageAttachment(attachment)) {
    return;
  }

  const bytes = await readAttachmentBytes(attachment);
  if (!bytes || bytes.byteLength === 0) {
    logWarn({
      action: "attachment_empty",
      scope: "telegram",
    });
    return;
  }

  assertTelegramImageBudget(bytes.byteLength, budget);

  return {
    rawBytes: bytes.byteLength,
    attachment: {
      dataBase64: bytesToBase64(bytes),
      mediaType: imageMediaType(attachment),
      ...(attachment.name?.trim() ? { filename: attachment.name.trim() } : {}),
    },
  };
}

function assertTelegramImageBudget(
  rawBytes: number,
  budget: { readonly count: number; readonly totalRawBytes: number }
): void {
  if (rawBytes > TELEGRAM_MAX_RAW_IMAGE_BYTES) {
    throw new TelegramAttachmentLimitError(
      `Image exceeds max raw size of ${TELEGRAM_MAX_RAW_IMAGE_BYTES} bytes before DO hop.`
    );
  }
  if (budget.count >= TELEGRAM_MAX_TURN_IMAGES) {
    throw new TelegramAttachmentLimitError(
      `Turn exceeds max of ${TELEGRAM_MAX_TURN_IMAGES} images.`
    );
  }
  if (budget.totalRawBytes + rawBytes > TELEGRAM_MAX_TURN_RAW_IMAGE_BYTES) {
    throw new TelegramAttachmentLimitError(
      `Turn exceeds max total raw image size of ${TELEGRAM_MAX_TURN_RAW_IMAGE_BYTES} bytes.`
    );
  }
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
  batchMessages,
  context,
  correlationId,
  deliverTurn,
  env,
  message,
  subscribe,
  thread,
}: {
  readonly batchMessages?: readonly ConversationMessage[];
  readonly context?: ConversationContext;
  readonly correlationId?: string;
  readonly deliverTurn: TurnDeliverer;
  readonly env: ConversationEnv;
  readonly message: ConversationMessage;
  readonly subscribe?: boolean;
  readonly thread: ConversationThread;
}): Promise<void> {
  const messages = batchMessages ?? [...(context?.skipped ?? []), message];
  const text = collectTurnTexts(messages);
  let attachments: readonly AgentRequestAttachment[] = [];
  try {
    attachments = await collectTurnImages(messages);
  } catch (error) {
    const normalized = normalizeError(error);
    if (error instanceof TelegramAttachmentLimitError) {
      logError(workerErrors.ATTACHMENT_LIMIT_EXCEEDED({ cause: normalized }), {
        scope: "telegram",
        action: "attachment_limit",
      });
    } else {
      logError(workerErrors.ATTACHMENT_FETCH_FAILED({ cause: normalized }), {
        scope: "telegram",
      });
    }
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
      ...(correlationId ? { correlationId } : {}),
      sessionScopeKey: telegramSessionScopeKeyFromMessages(messages),
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

  if (!response) {
    throw new Error("agent durable object failed: missing");
  }

  // 502 + body is used for missing send_message; parse body first.
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`agent durable object failed: ${response.status}`);
  }

  const payload = AgentDeliverySchema.safeParse(raw);
  if (payload.success) {
    if (payload.data.delivered) {
      return;
    }
    throw workerErrors.MISSING_SEND_MESSAGE();
  }

  if (!response.ok) {
    throw new Error(`agent durable object failed: ${response.status}`);
  }

  throw new Error(
    `agent durable object returned invalid delivery payload: ${response.status}`
  );
}

function asConversationMessage(message: Message): ConversationMessage {
  return message;
}

function telegramSessionScopeKey(
  message: ConversationMessage
): string | undefined {
  const userId = message.author?.userId?.trim();
  return userId ? `telegram:user:${userId}` : undefined;
}

function telegramSessionScopeKeyFromMessages(
  messages: readonly ConversationMessage[]
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const scope = telegramSessionScopeKey(messages[index] ?? {});
    if (scope) {
      return scope;
    }
  }
  return;
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
