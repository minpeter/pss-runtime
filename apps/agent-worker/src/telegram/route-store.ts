import type { CloudflareDurableObjectStorage } from "@minpeter/pss-runtime/cloudflare";

const telegramRouteStorageKey = "telegram:route";

export interface TelegramConversationRoute {
  readonly chatId: string;
  readonly sessionKey: string;
  readonly storePrefix: string;
  readonly userId: string;
}

export async function writeTelegramRoute(
  storage: CloudflareDurableObjectStorage,
  route: TelegramConversationRoute
): Promise<void> {
  await storage.put(telegramRouteStorageKey, route);
}

export async function readTelegramRoute(
  storage: CloudflareDurableObjectStorage
): Promise<TelegramConversationRoute | undefined> {
  return await storage.get<TelegramConversationRoute>(telegramRouteStorageKey);
}
