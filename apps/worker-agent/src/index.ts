import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Chat, type Message, type Thread } from "chat";

interface Env {
  readonly TELEGRAM_BOT_TOKEN: string;
  readonly TELEGRAM_BOT_USERNAME?: string;
  readonly TELEGRAM_WEBHOOK_SECRET_TOKEN?: string;
}

let bot: Chat | undefined;

function createBot(env: Env): Chat {
  const userName = env.TELEGRAM_BOT_USERNAME?.trim() || "pss_echo_bot";

  const chat = new Chat({
    adapters: {
      telegram: createTelegramAdapter({
        botToken: env.TELEGRAM_BOT_TOKEN,
        secretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        userName,
      }),
    },
    state: createMemoryState(),
    userName,
  });

  const echo = async (thread: Thread, message: Message): Promise<void> => {
    if (message.text) {
      await thread.post(`Echo: ${message.text}`);
    }
  };

  chat.onDirectMessage(echo);
  chat.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await echo(thread, message);
  });

  return chat;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    bot ??= createBot(env);
    return bot.webhooks.telegram(request);
  },
} satisfies ExportedHandler<Env>;