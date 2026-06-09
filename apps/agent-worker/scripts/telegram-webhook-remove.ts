import { pathToFileURL } from "node:url";
import { loadDevVars } from "./load-dev-vars";

interface TelegramApiResponse {
  readonly description?: string;
  readonly ok: boolean;
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

async function main(): Promise<void> {
  const botToken = loadDevVars().TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    console.log("TELEGRAM_BOT_TOKEN not set; skipping webhook remove");
    return;
  }

  await removeTelegramWebhook(botToken);
  console.log("telegram webhook removed");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}