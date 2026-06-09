import { pathToFileURL } from "node:url";
import { loadDevVars } from "./load-dev-vars";
import { resolveTelegramWebhookSecret } from "../src/telegram/webhook-secret";

const webhookPath = "/telegram/webhook";

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
  const payload = (await response.json()) as {
    readonly description?: string;
    readonly ok: boolean;
  };
  if (!response.ok || !payload.ok) {
    throw new Error(
      payload.description ??
        `setWebhook failed with status ${response.status}`
    );
  }
  return webhookUrl;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

async function main(): Promise<void> {
  const devVars = loadDevVars();
  const botToken = devVars.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required in .dev.vars");
  }

  const baseUrl = devVars.WORKER_PUBLIC_URL?.trim();
  if (!baseUrl) {
    throw new Error("WORKER_PUBLIC_URL is required in .dev.vars for webhook init");
  }

  const webhookSecret = devVars.TELEGRAM_WEBHOOK_SECRET?.trim();
  const webhookUrl = await registerTelegramWebhook({
    baseUrl,
    botToken,
    webhookSecret,
  });
  console.log(`telegram webhook -> ${webhookUrl}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}