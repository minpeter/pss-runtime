import { pathToFileURL } from "node:url";
import { loadDevVars } from "../lib/load-dev-vars";
import { registerTelegramBotCommands } from "./api";

export async function registerTelegramBotCommandsForToken(
  botToken: string | undefined
): Promise<boolean> {
  const trimmed = botToken?.trim();
  if (!trimmed) {
    return false;
  }

  await registerTelegramBotCommands(trimmed);
  return true;
}

export async function registerTelegramCommandsFromDevVars(): Promise<boolean> {
  return registerTelegramBotCommandsForToken(
    loadDevVars().TELEGRAM_BOT_TOKEN
  );
}

async function main(): Promise<void> {
  const registered = await registerTelegramCommandsFromDevVars();
  if (!registered) {
    console.log("TELEGRAM_BOT_TOKEN not set; skipping command registration");
    return;
  }

  console.log("telegram slash commands registered");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}