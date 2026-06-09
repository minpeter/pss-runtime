import { pathToFileURL } from "node:url";
import { loadDevVars } from "../lib/load-dev-vars";
import { registerTelegramWebhook } from "./api";

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
  console.log("telegram slash commands registered");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}