import { resolveTelegramWebhookSecret } from "../src/telegram/webhook-secret";

const localWebhookUrl = "http://127.0.0.1:8791/telegram/webhook";
const pollRetryMs = 2_000;
const forwardRetryMs = 1_000;
const maxForwardAttempts = 5;

interface TelegramUpdate {
  readonly update_id: number;
}

interface TelegramApiResponse<T> {
  readonly description?: string;
  readonly ok: boolean;
  readonly result?: T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function forwardTelegramUpdate(options: {
  readonly botToken: string;
  readonly signal: AbortSignal;
  readonly update: TelegramUpdate;
  readonly webhookSecret?: string;
}): Promise<boolean> {
  const secret = resolveTelegramWebhookSecret({
    botToken: options.botToken,
    webhookSecret: options.webhookSecret,
  });

  for (let attempt = 1; attempt <= maxForwardAttempts; attempt++) {
    try {
      const forwardResponse = await fetch(localWebhookUrl, {
        body: JSON.stringify(options.update),
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": secret,
        },
        method: "POST",
        signal: options.signal,
      });
      if (forwardResponse.ok) {
        return true;
      }
      console.warn(
        `local webhook forward attempt ${attempt}/${maxForwardAttempts} failed with status ${forwardResponse.status}`
      );
    } catch (error) {
      if (options.signal.aborted) {
        return false;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `local webhook forward attempt ${attempt}/${maxForwardAttempts} failed (${message})`
      );
    }
    if (attempt < maxForwardAttempts) {
      await sleep(forwardRetryMs);
    }
  }

  return false;
}

export async function startTelegramPollForward(options: {
  readonly botToken: string;
  readonly signal: AbortSignal;
  readonly webhookSecret?: string;
}): Promise<void> {
  let offset = 0;

  console.log("telegram polling -> local worker webhook");

  while (!options.signal.aborted) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${options.botToken}/getUpdates`,
        {
          body: JSON.stringify({
            allowed_updates: [
              "message",
              "edited_message",
              "callback_query",
              "message_reaction",
            ],
            offset,
            timeout: 30,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: options.signal,
        }
      );
      const payload = (await response.json()) as TelegramApiResponse<
        readonly TelegramUpdate[]
      >;
      if (!response.ok || !payload.ok) {
        throw new Error(
          payload.description ??
            `getUpdates failed with status ${response.status}`
        );
      }

      for (const update of payload.result ?? []) {
        const forwarded = await forwardTelegramUpdate({
          botToken: options.botToken,
          signal: options.signal,
          update,
          webhookSecret: options.webhookSecret,
        });
        if (!forwarded) {
          console.warn(
            `stopping poll batch at update ${update.update_id}; will retry on next getUpdates`
          );
          break;
        }
        offset = update.update_id + 1;
      }
    } catch (error) {
      if (options.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`telegram polling error (${message}), retrying...`);
      await sleep(pollRetryMs);
    }
  }
}