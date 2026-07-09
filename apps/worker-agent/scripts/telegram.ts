import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import { assertWebhookSecretToken } from "../src/env";
import { logError, logTagged } from "../src/worker-log";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";
const LOCAL_WEBHOOK = "http://127.0.0.1:8792/";
const TRAILING_SLASHES_PATTERN = /\/+$/;

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
  const response = await fetch(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "content-type": "application/json" } : undefined,
      method: "POST",
      signal,
    }
  );
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

export async function relay(): Promise<void> {
  const token = required("TELEGRAM_BOT_TOKEN");
  const secret = required("TELEGRAM_WEBHOOK_SECRET_TOKEN");
  assertWebhookSecretToken(secret);
  const webhookUrl = process.env.LOCAL_WEBHOOK_URL?.trim() || LOCAL_WEBHOOK;
  const abort = new AbortController();

  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());

  await telegramApi(token, "deleteWebhook", { drop_pending_updates: false });
  logTagged("info", "telegram-relay", `relay -> ${webhookUrl}`);

  let offset = 0;
  while (!abort.signal.aborted) {
    const updates = (await telegramApi(
      token,
      "getUpdates",
      { limit: 100, offset: offset || undefined, timeout: 30 },
      abort.signal
    )) as { readonly update_id: number }[];

    offset = await forwardUpdates({
      offset,
      secret,
      signal: abort.signal,
      updates,
      webhookUrl,
    });
  }
}

export async function forwardUpdates({
  offset,
  secret,
  signal,
  updates,
  webhookUrl,
}: {
  readonly offset: number;
  readonly secret: string;
  readonly signal: AbortSignal;
  readonly updates: readonly { readonly update_id: number }[];
  readonly webhookUrl: string;
}): Promise<number> {
  let nextOffset = offset;
  for (const update of updates) {
    let response: Response;
    try {
      response = await fetch(webhookUrl, {
        body: JSON.stringify(update),
        headers: {
          "content-type": "application/json",
          [SECRET_HEADER]: secret,
        },
        method: "POST",
        signal,
      });
    } catch (error) {
      if (error instanceof Error) {
        logError(error, {
          action: "webhook_forward_failed",
          scope: "telegram-relay",
        });
        break;
      }
      throw error;
    }
    if (!response.ok) {
      logError({
        action: "webhook_forward_status",
        scope: "telegram-relay",
        status: response.status,
      });
      break;
    }
    nextOffset = update.update_id + 1;
  }
  return nextOffset;
}

export async function webhook(): Promise<void> {
  const token = required("TELEGRAM_BOT_TOKEN");
  const secret = required("TELEGRAM_WEBHOOK_SECRET_TOKEN");
  assertWebhookSecretToken(secret);
  const url = `${required("WORKER_PUBLIC_URL").replace(TRAILING_SLASHES_PATTERN, "")}/`;

  await telegramApi(token, "setWebhook", {
    secret_token: secret,
    url,
  });
  logTagged("info", "telegram-relay", `webhook -> ${url}`);
}

export async function main(command = process.argv[2]): Promise<void> {
  loadDevVars();
  if (command === "relay") {
    await relay();
    return;
  }
  if (command === "webhook") {
    await webhook();
    return;
  }
  throw new Error("usage: telegram.ts relay|webhook");
}

function loadDevVars(): void {
  loadEnvFile(resolve(import.meta.dirname, "../.dev.vars"));
}

if (isMainModule(import.meta.url)) {
  await main();
}

function isMainModule(moduleUrl: string, argvPath = process.argv[1]): boolean {
  return (
    argvPath !== undefined &&
    moduleUrl === pathToFileURL(resolve(argvPath)).href
  );
}
