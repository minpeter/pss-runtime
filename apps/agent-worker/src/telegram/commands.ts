export interface TelegramBotCommand {
  readonly command: string;
  readonly description: string;
  readonly helpText: string;
}

export const telegramBotCommands: readonly TelegramBotCommand[] = [
  {
    command: "help",
    description: "Show help",
    helpText: "show this message",
  },
  {
    command: "start",
    description: "Show help",
    helpText: "same as `/help`",
  },
  {
    command: "debug_reset",
    description: "Reset conversation",
    helpText: "clear this chat's conversation history",
  },
];

export function matchesTelegramCommand(
  text: string,
  command: string
): boolean {
  return commandPattern(command).test(text.trim());
}

export function matchesHelpCommand(text: string): boolean {
  const trimmed = text.trim();
  return (
    matchesTelegramCommand(trimmed, "help") ||
    matchesTelegramCommand(trimmed, "start")
  );
}

export function matchesDebugResetCommand(text: string): boolean {
  return matchesTelegramCommand(text, "debug_reset");
}

function commandPattern(command: string): RegExp {
  return new RegExp(`^\\/${command}(?:@[A-Za-z0-9_]+)?(?:\\s|$)`, "i");
}