import { pathToFileURL } from "node:url";
import { loadDevVars } from "./load-dev-vars";
import { startTelegramPollForward } from "./telegram-poll-forward";
import { registerTelegramWebhook } from "./telegram-webhook-init";

const localDevUrl = "http://127.0.0.1:8791";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readWebhookSecret(): string | undefined {
  return loadDevVars().TELEGRAM_WEBHOOK_SECRET?.trim();
}

async function waitForLocalDevServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${localDevUrl}/`, {
        method: "GET",
        signal: AbortSignal.timeout(3_000),
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
  const botToken = loadDevVars().TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) {
    console.log("TELEGRAM_BOT_TOKEN not set; skipping telegram poll");
    return;
  }

  const webhookSecret = readWebhookSecret();
  const pollAbort = new AbortController();
  let shuttingDown = false;

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\nReceived ${signal}, stopping telegram poll...`);
    pollAbort.abort();
    try {
      await restoreProdWebhookIfConfigured(botToken, webhookSecret);
    } catch (error) {
      console.warn("failed to restore prod webhook:", error);
    }
    process.exit(exitCode);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  try {
    console.log("waiting for local dev server...");
    await waitForLocalDevServer();
    await startTelegramPollForward({
      botToken,
      signal: pollAbort.signal,
      webhookSecret,
    });
  } catch (error) {
    if (!pollAbort.signal.aborted) {
      console.error("telegram polling failed:", error);
      await shutdown("error", 1);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}