export type EnvironmentName = "development" | "production";

const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export class WorkerAgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerAgentConfigError";
  }
}

export interface Env {
  readonly AGENT_DO: DurableObjectNamespace;
  readonly AI_API_KEY: string;
  readonly AI_BASE_URL?: string;
  readonly AI_MODEL?: string;
  readonly ENVIRONMENT: EnvironmentName;
  readonly TELEGRAM_BOT_TOKEN: string;
  readonly TELEGRAM_BOT_USERNAME?: string;
  readonly TELEGRAM_WEBHOOK_SECRET_TOKEN: string;
}

export function isDevelopment(env: {
  readonly ENVIRONMENT: EnvironmentName;
}): boolean {
  return env.ENVIRONMENT === "development";
}

export function durableObjectName(channelId: string): string {
  return `tg-${channelId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function assertWebhookSecretToken(secret: string): void {
  if (WEBHOOK_SECRET_PATTERN.test(secret)) {
    return;
  }

  throw new WorkerAgentConfigError(
    "TELEGRAM_WEBHOOK_SECRET_TOKEN must be 1-256 chars and only use A-Z, a-z, 0-9, _ or -."
  );
}

export function readWebhookSecretToken(env: {
  readonly TELEGRAM_WEBHOOK_SECRET_TOKEN?: string;
}): string {
  const secret = env.TELEGRAM_WEBHOOK_SECRET_TOKEN?.trim();
  if (!secret) {
    throw new WorkerAgentConfigError(
      "TELEGRAM_WEBHOOK_SECRET_TOKEN is required."
    );
  }

  assertWebhookSecretToken(secret);
  return secret;
}
