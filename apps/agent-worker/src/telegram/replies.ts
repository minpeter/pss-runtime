export function helpMarkdown(): string {
  return [
    "**PSS Telegram chat**",
    "",
    "Send any plain message and the agent will reply.",
    "",
    "`/help` — show this message",
    "`/start` — same as `/help`",
  ].join("\n");
}