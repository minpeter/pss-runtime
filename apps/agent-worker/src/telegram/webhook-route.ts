const telegramWebhookPath = "/telegram/webhook";

export interface TelegramWebhookRoute {
  readonly chatId: string;
  readonly objectName: string;
  readonly userId: string;
}

export type ReadTelegramWebhookRouteResult =
  | { readonly ok: true; readonly routed: false }
  | { readonly error: string; readonly ok: false; readonly status: number }
  | { readonly ok: true; readonly routed: true; readonly route: TelegramWebhookRoute };

export function isTelegramWebhookPath(request: Request): boolean {
  const url = new URL(request.url);
  return request.method === "POST" && url.pathname === telegramWebhookPath;
}

export async function readTelegramWebhookRoute(
  request: Request
): Promise<ReadTelegramWebhookRouteResult> {
  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return { error: "invalid Telegram update JSON", ok: false, status: 400 };
  }

  const message = readTelegramMessage(update);
  if (!message) {
    return { ok: true, routed: false };
  }

  const chatId = readChatId(message);
  const userId = readUserId(message);
  if (!(chatId && userId)) {
    return { ok: true, routed: false };
  }

  return {
    ok: true,
    routed: true,
    route: {
      chatId,
      objectName: durableObjectName(chatId, userId),
      userId,
    },
  };
}

function durableObjectName(chatId: string, userId: string): string {
  return [
    "telegram-agent",
    "tenant",
    encodeURIComponent("telegram"),
    "conversation",
    encodeURIComponent(chatId),
    "user",
    encodeURIComponent(userId),
  ].join(":");
}

function readTelegramMessage(update: unknown): unknown {
  if (!isRecord(update)) {
    return;
  }
  return (
    update.message ??
    update.edited_message ??
    update.channel_post ??
    update.edited_channel_post
  );
}

function readChatId(message: unknown): string | undefined {
  if (!isRecord(message) || !isRecord(message.chat)) {
    return;
  }
  const chatId = message.chat.id;
  return typeof chatId === "number" || typeof chatId === "string"
    ? String(chatId)
    : undefined;
}

function readUserId(message: unknown): string | undefined {
  if (!isRecord(message) || !isRecord(message.from)) {
    return;
  }
  const userId = message.from.id;
  return typeof userId === "number" || typeof userId === "string"
    ? String(userId)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}