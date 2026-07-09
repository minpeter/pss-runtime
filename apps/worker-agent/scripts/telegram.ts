import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import { assertWebhookSecretToken } from "../src/env";
import { logError, logTagged } from "../src/worker-log";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";
const LOCAL_WEBHOOK = "http://127.0.0.1:8792/";
const TRAILING_SLASHES_PATTERN = /\/+$/;
/** Backoff after Telegram getUpdates network blips (ECONNRESET, etc.). */
const RELAY_RETRY_MS = 1000;

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required in .dev.vars`);
  }
  return value;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

export async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

/**
 * Highest exclusive offset after accepting `updates` (max update_id + 1).
 * Used for optimistic local ack so the next getUpdates is not blocked on
 * worker latency (cold start / long turns).
 */
export function peakOffset(
  offset: number,
  updates: readonly { readonly update_id: number }[]
): number {
  if (updates.length === 0) {
    return offset;
  }
  let maxId = offset > 0 ? offset - 1 : 0;
  for (const update of updates) {
    if (update.update_id > maxId) {
      maxId = update.update_id;
    }
  }
  return maxId + 1;
}

/** Best-effort wake of wrangler so the first real webhook is not ~800ms cold. */
export async function warmLocalWorker(
  webhookUrl: string,
  signal?: AbortSignal
): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: "GET",
      signal,
    });
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      return;
    }
    // GET may 404/405; connection success still warms the isolate.
    logTagged(
      "info",
      "telegram-relay",
      `warm probe finished (${error instanceof Error ? error.message : "ok"})`
    );
  }
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
  await warmLocalWorker(webhookUrl, abort.signal);
  logTagged("info", "telegram-relay", "worker warm probe done");

  let offset = 0;
  while (!abort.signal.aborted) {
    try {
      const updates = (await telegramApi(
        token,
        "getUpdates",
        { limit: 100, offset: offset || undefined, timeout: 30 },
        abort.signal
      )) as { readonly update_id: number }[];

      if (updates.length === 0) {
        continue;
      }

      // Optimistic ack: do not wait for worker responses before the next poll.
      // Otherwise a ~800ms cold webhook blocks getUpdates and the second half of
      // a dual text+photo send arrives ~0.85s later (serial poll lag).
      // Local-dev tradeoff: if forward fails after ack, Telegram will not resend.
      const claimedFrom = offset;
      const claimedThrough = peakOffset(offset, updates);
      offset = claimedThrough;

      void forwardUpdates({
        offset: claimedFrom,
        secret,
        signal: abort.signal,
        updates,
        webhookUrl,
      }).then((deliveredThrough) => {
        if (deliveredThrough < claimedThrough) {
          logError({
            action: "webhook_forward_incomplete_after_ack",
            scope: "telegram-relay",
            claimedFrom,
            claimedThrough,
            deliveredThrough,
            updateCount: updates.length,
          });
        }
      });
    } catch (error) {
      // Ctrl-C / process stop during long-poll — exit cleanly.
      if (abort.signal.aborted || isAbortError(error)) {
        break;
      }
      // Transient network errors (ECONNRESET on getUpdates) must not kill dev.
      logError(normalizeError(error), {
        action: "get_updates_failed",
        scope: "telegram-relay",
      });
      await sleepMs(RELAY_RETRY_MS, abort.signal);
    }
  }
}

type ForwardResult =
  | { readonly ok: true; readonly updateId: number }
  | {
      readonly ok: false;
      readonly aborted?: boolean;
      readonly error?: unknown;
      readonly status?: number;
      readonly updateId: number;
    };

/**
 * Forward one getUpdates batch to the local worker.
 *
 * Production Telegram webhooks hit the worker concurrently; relay used to
 * await each forward serially, which stretched dual text+photo updates by the
 * first request's latency (often ~cold-start). Forward the batch in parallel
 * so local timing matches cloud webhooks more closely.
 *
 * Offset still advances only through the longest successful prefix in
 * update_id order, so a mid-batch failure does not skip later ids.
 */
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
  if (updates.length === 0 || signal.aborted) {
    return offset;
  }

  const ordered = [...updates].sort(
    (left, right) => left.update_id - right.update_id
  );

  const results = await Promise.all(
    ordered.map((update) =>
      forwardOneUpdate({
        secret,
        signal,
        update,
        webhookUrl,
      })
    )
  );

  let nextOffset = offset;
  for (const result of results) {
    if (!result.ok) {
      if (result.aborted || signal.aborted) {
        break;
      }
      if (result.status !== undefined) {
        logError({
          action: "webhook_forward_status",
          scope: "telegram-relay",
          status: result.status,
          updateId: result.updateId,
        });
      } else if (result.error instanceof Error) {
        logError(result.error, {
          action: "webhook_forward_failed",
          scope: "telegram-relay",
          updateId: result.updateId,
        });
      } else if (result.error !== undefined) {
        logError(new Error(String(result.error)), {
          action: "webhook_forward_failed",
          scope: "telegram-relay",
          updateId: result.updateId,
        });
      }
      break;
    }
    nextOffset = result.updateId + 1;
  }
  return nextOffset;
}

async function forwardOneUpdate({
  secret,
  signal,
  update,
  webhookUrl,
}: {
  readonly secret: string;
  readonly signal: AbortSignal;
  readonly update: { readonly update_id: number };
  readonly webhookUrl: string;
}): Promise<ForwardResult> {
  if (signal.aborted) {
    return { ok: false, aborted: true, updateId: update.update_id };
  }
  try {
    const response = await fetch(webhookUrl, {
      body: JSON.stringify(update),
      headers: {
        "content-type": "application/json",
        [SECRET_HEADER]: secret,
      },
      method: "POST",
      signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        updateId: update.update_id,
      };
    }
    return { ok: true, updateId: update.update_id };
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return { ok: false, aborted: true, updateId: update.update_id };
    }
    return { ok: false, error, updateId: update.update_id };
  }
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

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(`Non-Error thrown: ${String(error)}`);
}

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    logError(normalizeError(error), {
      action: "relay_fatal",
      scope: "telegram-relay",
    });
    process.exitCode = 1;
  }
}

function isMainModule(moduleUrl: string, argvPath = process.argv[1]): boolean {
  return (
    argvPath !== undefined &&
    moduleUrl === pathToFileURL(resolve(argvPath)).href
  );
}
