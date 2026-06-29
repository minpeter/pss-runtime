import {
  ackScheduledCloudflareRun,
  ackScheduledCloudflareThreadPrompt,
  type CloudflareDurableObjectStorage,
  listScheduledCloudflareRuns,
  listScheduledCloudflareThreadPrompts,
} from "../cloudflare";
import {
  claimScheduledCloudflareRun,
  claimScheduledCloudflareThreadPrompt,
} from "../cloudflare/host/durable-object-host";
import {
  appendScheduledRun,
  appendScheduledThreadPrompt,
} from "../cloudflare/host/scheduled-work-queue";
import type {
  CloudflareAgentsFiberPayload,
  CloudflareAgentsThreadFiberPayload,
} from "./payload";

export async function mirrorCloudflareAgentsScheduledPayload({
  payload,
  storage,
}: {
  readonly payload: CloudflareAgentsFiberPayload;
  readonly runAfterMs: number;
  readonly storage?: CloudflareDurableObjectStorage;
}): Promise<void> {
  if (storage === undefined) {
    return;
  }
  switch (payload.kind) {
    case "run":
      await appendScheduledRun(storage, payload.prefix, payload.runId);
      return;
    case "thread":
      await appendScheduledThreadPrompt(
        storage,
        payload.prefix,
        threadPromptForPayload(payload)
      );
      return;
    default:
      return assertNeverPayload(payload);
  }
}

export async function claimCloudflareAgentsScheduledPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsFiberPayload
): Promise<boolean> {
  switch (payload.kind) {
    case "run":
      return await claimRun(storage, payload.prefix, payload.runId);
    case "thread":
      return await claimThreadPrompt(storage, payload);
    default:
      return assertNeverPayload(payload);
  }
}

export async function removeCloudflareAgentsScheduledPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsFiberPayload
): Promise<void> {
  switch (payload.kind) {
    case "run":
      await ackScheduledCloudflareRun(storage, payload.runId, {
        prefix: payload.prefix,
      });
      return;
    case "thread":
      await ackScheduledCloudflareThreadPrompt(
        storage,
        threadPromptForPayload(payload),
        { prefix: payload.prefix }
      );
      return;
    default:
      return assertNeverPayload(payload);
  }
}

export async function hasCloudflareAgentsScheduledPayload(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsFiberPayload
): Promise<boolean> {
  switch (payload.kind) {
    case "run":
      return (
        await listScheduledCloudflareRuns(storage, {
          prefix: payload.prefix,
        })
      ).includes(payload.runId);
    case "thread":
      return (
        await listScheduledCloudflareThreadPrompts(storage, {
          prefix: payload.prefix,
        })
      ).some((prompt) => scheduledThreadPromptMatchesPayload(prompt, payload));
    default:
      return assertNeverPayload(payload);
  }
}

async function claimRun(
  storage: CloudflareDurableObjectStorage,
  prefix: string,
  runId: string
): Promise<boolean> {
  return await claimScheduledCloudflareRun(storage, runId, { prefix });
}

async function claimThreadPrompt(
  storage: CloudflareDurableObjectStorage,
  payload: CloudflareAgentsThreadFiberPayload
): Promise<boolean> {
  return await claimScheduledCloudflareThreadPrompt(
    storage,
    threadPromptForPayload(payload),
    { prefix: payload.prefix }
  );
}

function scheduledThreadPromptMatchesPayload(
  prompt: {
    readonly idempotencyKey?: string;
    readonly notificationId?: string;
    readonly runId?: string;
    readonly threadKey: string;
  },
  payload: CloudflareAgentsThreadFiberPayload
): boolean {
  return (
    prompt.threadKey === payload.threadKey &&
    prompt.runId === payload.runId &&
    prompt.idempotencyKey === payload.idempotencyKey &&
    prompt.notificationId === payload.notificationId
  );
}

function threadPromptForPayload(payload: CloudflareAgentsThreadFiberPayload): {
  readonly idempotencyKey?: string;
  readonly notificationId?: string;
  readonly runId?: string;
  readonly threadKey: string;
} {
  return {
    idempotencyKey: payload.idempotencyKey,
    notificationId: payload.notificationId,
    runId: payload.runId,
    threadKey: payload.threadKey,
  };
}

function assertNeverPayload(payload: never): never {
  throw new TypeError(`Unsupported Cloudflare Agents payload: ${payload}`);
}
