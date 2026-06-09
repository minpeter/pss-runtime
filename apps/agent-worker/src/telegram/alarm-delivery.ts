import type { AgentEvent } from "@minpeter/pss-runtime";
import type { CloudflareAlarmDrainSummary } from "@minpeter/pss-runtime/cloudflare";
import { assistantTextFromEvents } from "./events";
import { telegramReplyBubbles } from "./reply-segments";
import type { TelegramConversationRoute } from "./route-store";

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

  const bubbles = telegramReplyBubbles(reply);
  for (const bubble of bubbles) {
    await postTelegramMessage({
      botToken,
      chatId: options.route.chatId,
      text: bubble,
    });
  }

  return bubbles;
}

async function postTelegramMessage(options: {
  readonly botToken: string;
  readonly chatId: string;
  readonly text: string;
}): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${options.botToken}/sendMessage`,
    {
      body: JSON.stringify({
        chat_id: options.chatId,
        text: options.text,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    }
  );
  if (!response.ok) {
    throw new Error(
      `Telegram sendMessage failed with status ${response.status}.`
    );
  }
}