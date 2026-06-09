import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type Message, type MessageContext, type Thread } from "chat";

interface Env {
  readonly TELEGRAM_BOT_TOKEN: string;
  readonly TELEGRAM_BOT_USERNAME?: string;
  readonly TELEGRAM_WEBHOOK_SECRET_TOKEN?: string;
}

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

  const echoBatch = async (
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
    await thread.post(`Echo: ${texts.join("\n")}`);
  };

  chat.onDirectMessage(async (thread, message, _channel, context) => {
    await echoBatch(thread, message, context);
  });
  chat.onNewMention(async (thread, message, context) => {
    await thread.subscribe();
    await echoBatch(thread, message, context);
  });

  return chat;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    bot ??= createBot(env);
    return bot.webhooks.telegram(request, {
      waitUntil: (task) => ctx.waitUntil(task),
    });
  },
} satisfies ExportedHandler<Env>;