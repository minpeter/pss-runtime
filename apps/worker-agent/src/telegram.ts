import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { fetchCloudflareDurableObject } from "@minpeter/pss-runtime/platform/cloudflare";
import { Chat, type Message, type MessageContext, type Thread } from "chat";
import { z } from "zod";

import { type ChannelAddress, channelKey } from "./channel";
import {
  durableObjectName,
  type Env,
  isDevelopment,
  readWebhookSecretToken,
} from "./env";

const DEV_NOTICE = "🧪 DEVELOPMENT ENVIRONMENT";
const FAILURE_REPLY =
  "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
const MISSING_SEND_MESSAGE_ERROR = "missing_send_message";
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

type TurnDeliverer = (channelId: string, text: string) => Promise<void>;

interface ConversationEnv {
  readonly ENVIRONMENT: Env["ENVIRONMENT"];
}

interface ConversationMessage {
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
      deliverTurn: (channelId, text) =>
        requestAgentDelivery(env, channelId, text),
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
  if (!text) {
    return;
  }

  try {
    if (subscribe) {
      await thread.subscribe();
    }
    if (isDevelopment(env)) {
      await thread.post(DEV_NOTICE);
    }

    await deliverTurn(thread.channelId, text);
  } catch (error) {
    console.error("telegram handler failed", normalizeError(error));
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
  text: string
): Promise<void> {
  const channel: ChannelAddress = { id: channelId, kind: "telegram" };
  const response = await fetchCloudflareDurableObject({
    namespace: env.AGENT_DO,
    objectName: durableObjectName(channelKey(channel)),
    request: new Request("https://agent.internal/turn", {
      body: JSON.stringify({
        channel,
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

  throw new Error("agent did not deliver a send_message result");
}

export function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const config = readBotConfig(env);
  if (!(cachedBot && isSameBotConfig(cachedBot.config, config))) {
    cachedBot = { bot: createBot(env, config), config };
  }
  return cachedBot.bot.webhooks.telegram(request, {
    waitUntil: (task) => ctx.waitUntil(task),
  });
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
