import { telegramBotCommands } from "../../src/telegram/commands";
import { resolveTelegramWebhookSecret } from "../../src/telegram/webhook-secret";

const webhookPath = "/telegram/webhook";
const trailingSlashPattern = /\/+$/;

interface TelegramApiResponse {
  readonly description?: string;
  readonly ok: boolean;
}

export interface RegisterTelegramWebhookOptions {
  readonly baseUrl: string;
  readonly botToken: string;
  readonly webhookSecret?: string;
}

export async function registerTelegramWebhook(
  options: RegisterTelegramWebhookOptions
): Promise<string> {
  const webhookUrl = `${normalizeBaseUrl(options.baseUrl)}${webhookPath}`;
  const secretToken = resolveTelegramWebhookSecret({
    botToken: options.botToken,
    webhookSecret: options.webhookSecret,
  });
  await callTelegramBotApi(options.botToken, "setWebhook", {
    secret_token: secretToken,
    url: webhookUrl,
  });
  await registerTelegramBotCommands(options.botToken);
  return webhookUrl;
}

export async function registerTelegramBotCommands(
  botToken: string
): Promise<void> {
  await callTelegramBotApi(botToken, "setMyCommands", {
    commands: telegramBotCommands.map((command) => ({
      command: command.command,
      description: command.description,
    })),
  });
}

export async function removeTelegramWebhook(botToken: string): Promise<void> {
  await callTelegramBotApi(botToken, "deleteWebhook", {
    drop_pending_updates: false,
  });
}

async function callTelegramBotApi(
  botToken: string,
  method: string,
  body: Record<string, unknown>
): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/${method}`,
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );
  const payload = (await response.json()) as TelegramApiResponse;
  if (!(response.ok && payload.ok)) {
    throw new Error(
      payload.description ?? `${method} failed with status ${response.status}`
    );
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(trailingSlashPattern, "");
}
