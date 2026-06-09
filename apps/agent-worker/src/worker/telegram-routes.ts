import {
  type CloudflareDurableObjectNamespace,
  type CloudflareDurableObjectStorage,
  fetchCloudflareDurableObject,
} from "@minpeter/pss-runtime/cloudflare";
import {
  createTelegramWebhookBot,
  MissingTelegramConfigError,
  type TelegramBotEnv,
  type TelegramWebhookBot,
} from "../telegram/bot";
import {
  isTelegramWebhookPath,
  readTelegramWebhookRoute,
} from "../telegram/webhook-route";
import { resolveTelegramWebhookSecret } from "../telegram/webhook-secret";
import { jsonResponse } from "./http";

export interface WorkerTelegramEnv extends TelegramBotEnv {
  readonly AGENT_DURABLE_OBJECT?: CloudflareDurableObjectNamespace;
}

export interface DurableTelegramRouteOptions {
  readonly bindings: TelegramBotEnv;
  readonly request: Request;
  readonly storage: CloudflareDurableObjectStorage;
  readonly waitUntil: (task: Promise<unknown>) => void;
}

const botCache = new WeakMap<
  CloudflareDurableObjectStorage,
  TelegramWebhookBot
>();
const telegramSecretHeader = "x-telegram-bot-api-secret-token";

export async function workerTelegramRouteResponse(options: {
  readonly bindings: WorkerTelegramEnv;
  readonly request: Request;
}): Promise<Response | undefined> {
  if (!isTelegramWebhookPath(options.request)) {
    return;
  }
  const secretError = rejectInvalidTelegramSecret(
    options.bindings,
    options.request
  );
  if (secretError) {
    return secretError;
  }
  const route = await readTelegramWebhookRoute(options.request.clone());
  if (!route.ok) {
    return jsonResponse({ error: route.error }, route.status);
  }
  if (!route.routed) {
    return jsonResponse({ ignored: true, ok: true });
  }

  const response = await fetchCloudflareDurableObject({
    namespace: options.bindings.AGENT_DURABLE_OBJECT,
    objectName: route.route.objectName,
    request: options.request,
  });
  if (response) {
    return response;
  }
  return jsonResponse(
    {
      error: "AGENT_DURABLE_OBJECT binding is required for /telegram/webhook.",
    },
    500
  );
}

export async function durableTelegramRouteResponse(
  options: DurableTelegramRouteOptions
): Promise<Response | undefined> {
  if (!isTelegramWebhookPath(options.request)) {
    return;
  }
  const secretError = rejectInvalidTelegramSecret(
    options.bindings,
    options.request
  );
  if (secretError) {
    return secretError;
  }
  try {
    return await cachedBot(options).handleWebhook(options.request, {
      waitUntil: options.waitUntil,
    });
  } catch (error) {
    if (error instanceof MissingTelegramConfigError) {
      return jsonResponse(
        { error: error.message, variableName: error.variableName },
        500
      );
    }
    throw error;
  }
}

function cachedBot(options: DurableTelegramRouteOptions): TelegramWebhookBot {
  const cached = botCache.get(options.storage);
  if (cached) {
    return cached;
  }
  const bot = createTelegramWebhookBot({
    bindings: options.bindings,
    storage: options.storage,
  });
  botCache.set(options.storage, bot);
  return bot;
}

function rejectInvalidTelegramSecret(
  bindings: TelegramBotEnv,
  request: Request
): Response | undefined {
  const botToken = readEnv(bindings.TELEGRAM_BOT_TOKEN);
  if (!botToken) {
    return jsonResponse(
      {
        error: "TELEGRAM_BOT_TOKEN is required for /telegram/webhook.",
        variableName: "TELEGRAM_BOT_TOKEN",
      },
      500
    );
  }
  const secret = resolveTelegramWebhookSecret({
    botToken,
    webhookSecret: bindings.TELEGRAM_WEBHOOK_SECRET,
  });
  const header = request.headers.get(telegramSecretHeader);
  if (header && constantTimeEqual(header, secret)) {
    return;
  }
  return jsonResponse({ error: "invalid Telegram webhook secret token" }, 401);
}

function readEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  const length = Math.max(actualBytes.length, expectedBytes.length);
  let diff = Math.abs(actualBytes.length - expectedBytes.length);
  for (let index = 0; index < length; index += 1) {
    diff += Math.abs((actualBytes[index] ?? 0) - (expectedBytes[index] ?? 0));
  }
  return diff === 0;
}
