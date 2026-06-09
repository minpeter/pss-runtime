import { telegramBotCommands } from "./commands";

export function telegramMarkdownMessage(text: string): {
  readonly markdown: string;
} {
  return { markdown: text };
}

export function splitReplyBubbles(text: string): readonly string[] {
  const bubbles = text
    .split("\n\n")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return bubbles.length > 0 ? bubbles : [text];
}

export function helpMarkdown(): string {
  const commandLines = telegramBotCommands.map(
    (command) => `\`/${command.command}\` — ${command.helpText}`
  );
  return [
    "**PSS Telegram chat**",
    "",
    "Send any plain message and the agent will reply.",
    "",
    ...commandLines,
  ].join("\n");
}

export function debugResetConfirmation(): string {
  return "Conversation reset. Your next message starts a new session.";
}
