import { pathToFileURL } from "node:url";
import { loadDevVars } from "../lib/load-dev-vars";
import { removeTelegramWebhook } from "./api";

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