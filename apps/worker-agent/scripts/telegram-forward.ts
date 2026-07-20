import { logError } from "../src/worker-log";
import { isAbortError, SECRET_HEADER } from "./telegram-helpers";

type ForwardResult =
  | { readonly ok: true; readonly updateId: number }
  | {
      readonly ok: false;
      readonly aborted?: boolean;
      readonly error?: unknown;
      readonly status?: number;
      readonly updateId: number;
    };

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
