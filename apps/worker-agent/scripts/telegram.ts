import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

loadEnvFile(resolve(import.meta.dirname, "../.dev.vars"));

const SECRET_HEADER = "x-telegram-bot-api-secret-token";
const LOCAL_WEBHOOK = "http://127.0.0.1:8792/";

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required in .dev.vars`);
  }
  return value;
}

async function telegramApi(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { "content-type": "application/json" } : undefined,
    method: "POST",
    signal,
  });
  const payload = (await response.json()) as {
    readonly description?: string;
    readonly ok: boolean;
    readonly result?: unknown;
  };
  if (!payload.ok) {
    throw new Error(payload.description ?? `${method} failed`);
  }
  return payload.result;
}

async function relay(): Promise<void> {
  const token = required("TELEGRAM_BOT_TOKEN");
  const secret = required("TELEGRAM_WEBHOOK_SECRET_TOKEN");
  const webhookUrl = process.env.LOCAL_WEBHOOK_URL?.trim() || LOCAL_WEBHOOK;
  const abort = new AbortController();

  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());

  await telegramApi(token, "deleteWebhook", { drop_pending_updates: false });
  console.log(`relay -> ${webhookUrl}`);

  let offset = 0;
  while (!abort.signal.aborted) {
    const updates = (await telegramApi(
      token,
      "getUpdates",
      { limit: 100, offset: offset || undefined, timeout: 30 },
      abort.signal
    )) as { readonly update_id: number }[];

    for (const update of updates) {
      const response = await fetch(webhookUrl, {
        body: JSON.stringify(update),
        headers: {
          "content-type": "application/json",
          [SECRET_HEADER]: secret,
        },
        method: "POST",
        signal: abort.signal,
      });
      if (response.ok) {
        offset = update.update_id + 1;
      } else {
        console.error(`webhook ${response.status}`);
      }
    }
  }
}

async function webhook(): Promise<void> {
  const token = required("TELEGRAM_BOT_TOKEN");
  const secret = required("TELEGRAM_WEBHOOK_SECRET_TOKEN");
  const url = `${required("WORKER_PUBLIC_URL").replace(/\/+$/, "")}/`;

  await telegramApi(token, "setWebhook", {
    secret_token: secret,
    url,
  });
  console.log(`webhook -> ${url}`);
}

const command = process.argv[2];
if (command === "relay") {
  await relay();
} else if (command === "webhook") {
  await webhook();
} else {
  throw new Error("usage: telegram.ts relay|webhook");
}