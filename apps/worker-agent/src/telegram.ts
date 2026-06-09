import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createMemoryState } from "@chat-adapter/state-memory";
import { fetchCloudflareDurableObject } from "@minpeter/pss-runtime/cloudflare";
import { Chat, type Message, type MessageContext, type Thread } from "chat";

import { durableObjectName, isDevelopment, type Env } from "./env";

const DEV_NOTICE = "🧪 DEVELOPMENT ENVIRONMENT";

let bot: Chat | undefined;

function createBot(env: Env): Chat {
  const userName = env.TELEGRAM_BOT_USERNAME?.trim() || "pss_echo_bot";

  const chat = new Chat({
    concurrency: "queue",
    adapters: {
      telegram: createTelegramAdapter({
        botToken: env.TELEGRAM_BOT_TOKEN,
        mode: "webhook",
        secretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        userName,
      }),
    },
    state: createMemoryState(),
    userName,
  });

  const replyBatch = async (
    thread: Thread,
    message: Message,
    context?: MessageContext
  ): Promise<void> => {
    const texts = [...(context?.skipped ?? []), message]
      .map((item) => item.text)
      .filter((text): text is string => Boolean(text));
    if (texts.length === 0) {
      return;
    }

    if (isDevelopment(env)) {
      await thread.post(DEV_NOTICE);
    }

    const reply = await requestAgentReply(env, thread.channelId, texts.join("\n"));
    await thread.post(reply);
  };

  chat.onDirectMessage(async (thread, message, _channel, context) => {
    await replyBatch(thread, message, context);
  });
  chat.onNewMention(async (thread, message, context) => {
    await thread.subscribe();
    await replyBatch(thread, message, context);
  });

  return chat;
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
    throw new Error(`agent durable object failed: ${response?.status ?? "missing"}`);
  }

  const payload = (await response.json()) as { readonly reply?: string };
  return payload.reply?.trim() || "(no response)";
}

export function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  bot ??= createBot(env);
  return bot.webhooks.telegram(request, {
    waitUntil: (task) => ctx.waitUntil(task),
  });
}