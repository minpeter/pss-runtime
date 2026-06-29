import type { AgentEvent } from "../../thread/protocol/events";
import type { AgentTurn } from "../../thread/protocol/turn";
import type { CloudflareDurableObjectStorage } from "../cloudflare";
import type { CloudflareAgentsFiberPayload } from "./payload";

export type CloudflareAgentsFiberStatus =
  | "aborted"
  | "completed"
  | "error"
  | "interrupted"
  | "pending"
  | "running";

export interface CloudflareAgentsFiberContext {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly snapshot: unknown | null;
  stash(data: unknown): void;
}

export interface CloudflareAgentsFiberRecoveryContext {
  readonly createdAt: number;
  readonly id: string;
  readonly idempotencyKey?: string;
  readonly metadata?: Record<string, unknown> | null;
  readonly name: string;
  readonly recoveryReason: "interrupted";
  readonly snapshot: unknown | null;
  readonly status?: CloudflareAgentsFiberStatus;
}

export interface CloudflareAgentsFiberRecoveryResult {
  readonly error?: string;
  readonly snapshot?: unknown;
  readonly status: "aborted" | "completed" | "error" | "interrupted";
}

export interface CloudflareAgentsStartFiberOptions {
  readonly idempotencyKey?: string;
  readonly metadata?: Record<string, unknown>;
  readonly waitForCompletion?: boolean;
}

export interface CloudflareAgentsStartFiberResult {
  readonly accepted: boolean;
  readonly error?: unknown;
  readonly fiberId?: string;
  readonly status?: CloudflareAgentsFiberStatus;
}

export interface CloudflareAgentsScheduleOptions {
  readonly idempotent?: boolean;
  readonly retry?: unknown;
}

export interface CloudflareAgentsSchedule<TPayload> {
  readonly callback: string;
  readonly id: string;
  readonly payload: TPayload;
  readonly type: "cron" | "delayed" | "interval" | "scheduled";
}

export interface CloudflareAgentsDurableObjectContext {
  readonly storage: CloudflareDurableObjectStorage;
  waitUntil?(promise: Promise<unknown>): void;
}

export type CloudflareAgentsCallbackName<
  TAgent extends CloudflareAgentsPlatformAgent = CloudflareAgentsPlatformAgent,
> = Extract<keyof TAgent, string>;

export interface CloudflareAgentsPlatformAgent {
  schedule<TPayload extends CloudflareAgentsFiberPayload>(
    when: Date | number | string,
    callback: keyof this,
    payload: TPayload,
    options?: CloudflareAgentsScheduleOptions
  ): Promise<CloudflareAgentsSchedule<TPayload>>;
  startFiber(
    name: string,
    fn: (ctx: CloudflareAgentsFiberContext) => Promise<void>,
    options?: CloudflareAgentsStartFiberOptions
  ): Promise<CloudflareAgentsStartFiberResult>;
}

export interface CloudflareAgentsTurnDrainOptions {
  readonly deadlineMs?: number;
  readonly maxEvents?: number;
  readonly onEvent?: (event: AgentEvent) => Promise<void> | void;
}

export type CloudflareAgentsResumeRun = (
  payload: CloudflareAgentsFiberPayload
) => Promise<AgentTurn | null>;
