import type { AgentEvent, AgentTurn } from "../../index";
import { InMemoryCloudflareDurableObjectStorage } from "../cloudflare";
import { InMemorySqlStorage } from "../cloudflare/sql/node-test/node-sqlite-storage";
import type {
  CloudflareAgentsDurableObjectContext,
  CloudflareAgentsFiberPayload,
  CloudflareAgentsPlatformAgent,
} from "./index";

interface StartedFiber {
  readonly idempotencyKey: string | undefined;
  readonly name: string;
  readonly snapshot: unknown;
}

interface ScheduledFiber {
  readonly callback: string;
  readonly idempotent: boolean | undefined;
  readonly payload: CloudflareAgentsFiberPayload;
  readonly when: Date | number | string;
}

export interface FakeCloudflareAgent extends CloudflareAgentsPlatformAgent {
  readonly durableObjectContext: CloudflareAgentsDurableObjectContext;
  resumePssRuntimeFiber(payload: unknown): Promise<void>;
  readonly scheduled: ScheduledFiber[];
  readonly started: StartedFiber[];
}

export function createFakeCloudflareAgent(): FakeCloudflareAgent {
  const scheduled: ScheduledFiber[] = [];
  const started: StartedFiber[] = [];
  const durableObjectContext: CloudflareAgentsDurableObjectContext = {
    storage: new InMemoryCloudflareDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    }),
    waitUntil: () => undefined,
  };
  return {
    durableObjectContext,
    resumePssRuntimeFiber: () => Promise.resolve(),
    schedule: (when, callback, payload, options) => {
      scheduled.push({
        callback: String(callback),
        idempotent: options?.idempotent,
        payload,
        when,
      });
      return Promise.resolve({
        callback: String(callback),
        delayInSeconds: typeof when === "number" ? when : 0,
        id: `schedule-${scheduled.length}`,
        payload,
        time: Date.now(),
        type: "delayed",
      });
    },
    scheduled,
    startFiber: async (name, fn, options) => {
      const fiberId = `fiber-${started.length + 1}`;
      let snapshot: unknown;
      await fn({
        id: fiberId,
        signal: new AbortController().signal,
        snapshot: null,
        stash: (value) => {
          snapshot = value;
        },
      });
      started.push({
        idempotencyKey: options?.idempotencyKey,
        name,
        snapshot,
      });
      return {
        accepted: true,
        createdAt: Date.now(),
        fiberId,
        idempotencyKey: options?.idempotencyKey,
        metadata: options?.metadata,
        name,
        snapshot,
        status: "completed",
      };
    },
    started,
  };
}

export function runWithText(text: string): AgentTurn {
  return {
    events: () => eventStream([{ text, type: "assistant-output" }]),
  };
}

async function* eventStream(
  events: readonly AgentEvent[]
): AsyncIterable<AgentEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}
