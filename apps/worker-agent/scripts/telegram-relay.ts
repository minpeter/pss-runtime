import { assertWebhookSecretToken } from "../src/env";
import { logError, logTagged } from "../src/worker-log";
import { forwardUpdates } from "./telegram-forward";
import {
  isAbortError,
  normalizeError,
  peakOffset,
  required,
  sleepMs,
  telegramApi,
  warmLocalWorker,
} from "./telegram-helpers";

const LOCAL_WEBHOOK = "http://127.0.0.1:8792/";
const TRAILING_SLASHES_PATTERN = /\/+$/;
const RELAY_RETRY_MS = 1000;

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
  await warmLocalWorker(webhookUrl, secret, abort.signal);
  logTagged("info", "telegram-relay", "worker warm probe done");

  let offset = 0;
  const inFlightForwards = new Set<Promise<unknown>>();
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

      const claimedFrom = offset;
      const claimedThrough = peakOffset(offset, updates);
      offset = claimedThrough;

      const forwardTask = forwardUpdates({
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
      inFlightForwards.add(forwardTask);
      forwardTask.finally(() => {
        inFlightForwards.delete(forwardTask);
      });
    } catch (error) {
      if (abort.signal.aborted || isAbortError(error)) {
        break;
      }
      logError(normalizeError(error), {
        action: "get_updates_failed",
        scope: "telegram-relay",
      });
      await sleepMs(RELAY_RETRY_MS, abort.signal);
    }
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
