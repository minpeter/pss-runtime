import { pathToFileURL } from "node:url";
import { loadDevVars } from "../lib/load-dev-vars";
import { localDevOrigin } from "../lib/local-dev";
import { sleep } from "../lib/sleep";
import { registerTelegramWebhook } from "../webhook/api";
import { registerTelegramCommandsFromDevVars } from "../webhook/commands";
import { startTelegramPollForward } from "./poll-forward";

async function waitForLocalDevServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${localDevOrigin}/`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      if (response.status < 500) {
        return;
      }
    } catch {
      // wrangler is still starting
    }
    await sleep(500);
  }
  throw new Error(`local dev server did not start within ${timeoutMs}ms`);
}

async function restoreProdWebhookIfConfigured(
  botToken: string,
  webhookSecret: string | undefined
): Promise<void> {
  const workerPublicUrl = loadDevVars().WORKER_PUBLIC_URL?.trim();
  if (!workerPublicUrl) {
    return;
  }
  const webhookUrl = await registerTelegramWebhook({
    baseUrl: workerPublicUrl,
    botToken,
    webhookSecret,
  });
  console.log(`restored prod telegram webhook -> ${webhookUrl}`);
}

async function main(): Promise<void> {
  const devVars = loadDevVars();
  const botToken = devVars.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    console.log("TELEGRAM_BOT_TOKEN not set; skipping telegram poll");
    return;
  }

  const webhookSecret = devVars.TELEGRAM_WEBHOOK_SECRET?.trim();
  const pollAbort = new AbortController();
  let shuttingDown = false;

  const shutdown = async (exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log("\nstopping telegram poll...");
    pollAbort.abort();
    try {
      await restoreProdWebhookIfConfigured(botToken, webhookSecret);
    } catch (error) {
      console.warn("failed to restore prod webhook:", error);
    }
    process.exit(exitCode);
  };

  const shutdownFromSignal = (): void => {
    shutdown().catch((error: unknown) => {
      console.error("telegram polling shutdown failed:", error);
      process.exit(1);
    });
  };

  process.on("SIGINT", () => {
    shutdownFromSignal();
  });
  process.on("SIGTERM", () => {
    shutdownFromSignal();
  });

  try {
    console.log("waiting for local dev server...");
    await waitForLocalDevServer();
    if (await registerTelegramCommandsFromDevVars()) {
      console.log("telegram slash commands registered");
    }
    await startTelegramPollForward({
      botToken,
      signal: pollAbort.signal,
      webhookSecret,
    });
  } catch (error) {
    if (!pollAbort.signal.aborted) {
      console.error("telegram polling failed:", error);
      await shutdown(1);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
