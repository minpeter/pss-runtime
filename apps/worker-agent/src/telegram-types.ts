import { AsyncLocalStorage } from "node:async_hooks";

import type { Chat } from "chat";

import type { AgentRequestAttachment } from "./agent-do-request";
import {
  AGENT_MAX_RAW_IMAGE_BYTES,
  AGENT_MAX_TURN_IMAGES,
  AGENT_MAX_TURN_RAW_IMAGE_BYTES,
} from "./attachment-limits";
import type { Env } from "./env";

export const correlationStore = new AsyncLocalStorage<string>();
export const waitUntilStore = new AsyncLocalStorage<
  (task: Promise<unknown>) => void
>();

export const TELEGRAM_COALESCE_QUIET_MS = 1200;
export const TELEGRAM_MESSAGE_CONCURRENCY = {
  strategy: "concurrent",
} as const;
export const TELEGRAM_MAX_TURN_IMAGES = AGENT_MAX_TURN_IMAGES;
export const TELEGRAM_MAX_RAW_IMAGE_BYTES = AGENT_MAX_RAW_IMAGE_BYTES;
export const TELEGRAM_MAX_TURN_RAW_IMAGE_BYTES = AGENT_MAX_TURN_RAW_IMAGE_BYTES;

export interface TurnDeliveryOptions {
  readonly attachments?: readonly AgentRequestAttachment[];
  readonly correlationId?: string;
  readonly sessionScopeKey?: string;
}

export type TurnDeliverer = (
  channelId: string,
  text: string,
  options?: TurnDeliveryOptions
) => Promise<void>;

export interface ConversationEnv {
  readonly ENVIRONMENT: Env["ENVIRONMENT"];
}

export interface ConversationAttachment {
  readonly data?: ArrayBuffer | Blob | Uint8Array;
  readonly fetchData?: () => Promise<ArrayBuffer | Blob | Uint8Array>;
  readonly mimeType?: string;
  readonly name?: string;
  readonly type: "audio" | "file" | "image" | "video";
}

export interface ConversationMessage {
  readonly attachments?: readonly ConversationAttachment[];
  readonly author?: {
    readonly userId?: string;
  };
  readonly text?: string;
}

export interface ConversationContext {
  readonly skipped: readonly ConversationMessage[];
}

export interface ConversationThread {
  readonly channelId: string;
  post(message: string): Promise<unknown>;
  subscribe(): Promise<unknown>;
}

export interface BotConfig {
  readonly agentNamespace: DurableObjectNamespace;
  readonly botToken: string;
  readonly environment: Env["ENVIRONMENT"];
  readonly secretToken: string;
  readonly userName: string;
}

export interface CachedBot {
  readonly bot: Chat;
  readonly config: BotConfig;
}
