import { logTagged } from "../src/worker-log";

export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export function required(key: string): string {
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

export async function telegramApi(
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
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `${method} failed with status ${response.status}: ${text || response.statusText}`
    );
  }
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

export async function warmLocalWorker(
  webhookUrl: string,
  secret: string,
  signal?: AbortSignal
): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SECRET_HEADER]: secret,
      },
      body: JSON.stringify({ update_id: 0 }),
      signal,
    });
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      return;
    }
    logTagged(
      "info",
      "telegram-relay",
      `warm probe finished (${error instanceof Error ? error.message : "ok"})`
    );
  }
}

export function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(`Non-Error thrown: ${String(error)}`);
}
