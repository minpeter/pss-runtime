import { createMemoryState } from "@chat-adapter/state-memory";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { fetchCloudflareDurableObject } from "@minpeter/pss-runtime/cloudflare";
import { Chat, type Message, type MessageContext, type Thread } from "chat";
import { z } from "zod";

import {
  durableObjectName,
  type Env,
  isDevelopment,
  readWebhookSecretToken,
} from "./env";

const DEV_NOTICE = "🧪 DEVELOPMENT ENVIRONMENT";
const FAILURE_REPLY =
  "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
const AgentReplySchema = z.object({
  reply: z.string().optional(),
});

let bot: Chat | undefined;
let botConfigKey: string | undefined;

type ReplyFetcher = (
  env: ConversationEnv,
  channelId: string,
  text: string
) => Promise<string>;

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

function createBot(env: Env): Chat {
  const userName = env.TELEGRAM_BOT_USERNAME?.trim() || "pss_echo_bot";
  const secretToken = readWebhookSecretToken(env);

  const chat = new Chat({
    concurrency: "queue",
    adapters: {
      telegram: createTelegramAdapter({
        botToken: env.TELEGRAM_BOT_TOKEN,
        mode: "webhook",
        secretToken,
        userName,
      }),
    },
    state: createMemoryState(),
    userName,
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
      fetchReply: (_env, channelId, text) =>
        requestAgentReply(env, channelId, text),
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
  env,
  fetchReply,
  message,
  subscribe,
  thread,
}: {
  readonly context?: MessageContext;
  readonly env: ConversationEnv;
  readonly fetchReply: ReplyFetcher;
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

    const reply = await fetchReply(env, thread.channelId, text);
    await thread.post(reply);
  } catch (error) {
    console.error("telegram handler failed", describeError(error));
    await thread.post(FAILURE_REPLY);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function requestAgentReply(
  env: Env,
  channelId: string,
  text: string
): Promise<string> {
  const response = await fetchCloudflareDurableObject({
    namespace: env.AGENT_DO,
    objectName: durableObjectName(channelId),
    request: new Request("https://agent.internal/turn", {
      body: JSON.stringify({ text }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  });

  if (!response?.ok) {
    throw new Error(
      `agent durable object failed: ${response?.status ?? "missing"}`
    );
  }

  const payload = AgentReplySchema.parse(await response.json());
  return payload.reply?.trim() || "(no response)";
}

export function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const nextConfigKey = telegramBotConfigKey(env);
  if (!bot || botConfigKey !== nextConfigKey) {
    bot = createBot(env);
    botConfigKey = nextConfigKey;
  }
  return bot.webhooks.telegram(request, {
    waitUntil: (task) => ctx.waitUntil(task),
  });
}

function telegramBotConfigKey(env: Env): string {
  return JSON.stringify({
    botToken: env.TELEGRAM_BOT_TOKEN,
    environment: env.ENVIRONMENT,
    secretToken: readWebhookSecretToken(env),
    userName: env.TELEGRAM_BOT_USERNAME?.trim() || "pss_echo_bot",
  });
}
