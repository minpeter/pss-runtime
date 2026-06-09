export type EnvironmentName = "development" | "production";

export interface Env {
  readonly AGENT_DO: DurableObjectNamespace;
  readonly ENVIRONMENT: EnvironmentName;
  readonly AI_API_KEY: string;
  readonly AI_BASE_URL?: string;
  readonly AI_MODEL?: string;
  readonly TELEGRAM_BOT_TOKEN: string;
  readonly TELEGRAM_BOT_USERNAME?: string;
  readonly TELEGRAM_WEBHOOK_SECRET_TOKEN?: string;
}

export function isDevelopment(env: Env): boolean {
  return env.ENVIRONMENT === "development";
}

export function durableObjectName(channelId: string): string {
  return `tg-${channelId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}