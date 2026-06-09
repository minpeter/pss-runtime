import { resolveTelegramWebhookSecret } from "../../src/telegram/webhook-secret";

const webhookPath = "/telegram/webhook";

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
  const response = await fetch(
    `https://api.telegram.org/bot${options.botToken}/setWebhook`,
    {
      body: JSON.stringify({
        secret_token: secretToken,
        url: webhookUrl,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );
  const payload = (await response.json()) as TelegramApiResponse;
  if (!response.ok || !payload.ok) {
    throw new Error(
      payload.description ??
        `setWebhook failed with status ${response.status}`
    );
  }
  return webhookUrl;
}

export async function removeTelegramWebhook(botToken: string): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/deleteWebhook`,
    {
      body: JSON.stringify({ drop_pending_updates: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }
  );
  const payload = (await response.json()) as TelegramApiResponse;
  if (!response.ok || !payload.ok) {
    throw new Error(
      payload.description ??
        `deleteWebhook failed with status ${response.status}`
    );
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}