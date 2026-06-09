import { createTelegramAdapter } from "@chat-adapter/telegram";
import type { AgentEvent } from "@minpeter/pss-runtime";
import type { CloudflareAlarmDrainSummary } from "@minpeter/pss-runtime/cloudflare";
import { assistantTextFromEvents } from "./events";
import { telegramMarkdownMessage } from "./replies";
import { telegramReplyBubbles } from "./reply-segments";
import type { TelegramConversationRoute } from "./route-store";

const telegramBotUserName = "pss_agent";

export function assistantTextFromAlarmSummary(
  summary: CloudflareAlarmDrainSummary
): string | undefined {
  return assistantTextFromEvents(summary.events as readonly AgentEvent[]);
}

export async function deliverAlarmAssistantText(options: {
  readonly bindings: { readonly TELEGRAM_BOT_TOKEN?: string };
  readonly route: TelegramConversationRoute;
  readonly summary: CloudflareAlarmDrainSummary;
}): Promise<readonly string[]> {
  const reply = assistantTextFromAlarmSummary(options.summary);
  if (!reply) {
    return [];
  }

  const botToken = options.bindings.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    return [];
  }

  const telegram = createTelegramAdapter({
    botToken,
    userName: telegramBotUserName,
  });
  const threadId = telegramThreadId(options.route.chatId);
  const bubbles = telegramReplyBubbles(reply);
  for (const bubble of bubbles) {
    await telegram.postMessage(threadId, telegramMarkdownMessage(bubble));
  }

  return bubbles;
}

function telegramThreadId(chatId: string): string {
  return `telegram:${chatId}`;
}
