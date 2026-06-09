const disallowedTelegramSecretChars = /[^A-Za-z0-9_-]/g;
const maxWebhookSecretLength = 256;

export function telegramWebhookSecretFromBotToken(botToken: string): string {
  return botToken.replace(disallowedTelegramSecretChars, "_").slice(0, maxWebhookSecretLength);
}

export function resolveTelegramWebhookSecret(options: {
  readonly botToken: string;
  readonly webhookSecret?: string;
}): string {
  const explicit = options.webhookSecret?.trim();
  if (explicit) {
    return explicit.slice(0, maxWebhookSecretLength);
  }
  return telegramWebhookSecretFromBotToken(options.botToken);
}