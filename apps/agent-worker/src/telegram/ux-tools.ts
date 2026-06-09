import { type ToolSet, tool } from "ai";
import { z } from "zod";
import type { TelegramThreadLike } from "./handler";
import { telegramMarkdownMessage } from "./replies";

export interface TelegramUxContext {
  readonly messageId: string;
  readonly thread: TelegramThreadLike;
}

export function toTelegramUxContext(
  thread: TelegramThreadLike,
  messageId: string
): TelegramUxContext {
  return { messageId, thread };
}

export function createTelegramUxTools(context: TelegramUxContext): ToolSet {
  return {
    display_draft: tool({
      description:
        "Display a long draft reply to the user as a single Telegram message.",
      execute: async ({ text }) => {
        await context.thread.post(telegramMarkdownMessage(text));
        return { displayed: true, length: text.length };
      },
      inputSchema: z.object({
        text: z.string().describe("Full draft text to show the user."),
      }),
    }),
    reactto_message: tool({
      description:
        "React to the user's current message with an emoji on Telegram.",
      execute: async ({ emoji }) => {
        await context.thread.addReaction(emoji);
        return { emoji, ok: true };
      },
      inputSchema: z.object({
        emoji: z
          .string()
          .describe(
            "Emoji to react with (Unicode emoji or platform shortcode)."
          ),
      }),
    }),
  };
}
