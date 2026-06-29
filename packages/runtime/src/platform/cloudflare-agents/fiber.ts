import { drainAgentTurnWithBudget } from "../cloudflare";
import {
  type CloudflareAgentsFiberPayload,
  cloudflareAgentsFiberIdempotencyKey,
  cloudflareAgentsFiberMetadata,
  cloudflareAgentsFiberName,
  parseCloudflareAgentsFiberPayload,
} from "./payload";
import {
  areCloudflareAgentsPayloadsEquivalent,
  type CloudflareAgentsPayloadTrustOptions,
  cloudflareAgentsTrustFailureReason,
  isCloudflareAgentsPayloadTrusted,
  isCloudflareAgentsRecoveryContextTrusted,
  rejectedCloudflareAgentsFiberResult,
} from "./trust";
import type {
  CloudflareAgentsFiberRecoveryContext,
  CloudflareAgentsFiberRecoveryResult,
  CloudflareAgentsPlatformAgent,
  CloudflareAgentsResumeRun,
  CloudflareAgentsRetryFiber,
  CloudflareAgentsRetryReason,
  CloudflareAgentsStartFiberResult,
  CloudflareAgentsTurnDrainOptions,
} from "./types";

export interface StartCloudflareAgentsResumeFiberOptions {
  readonly cloudflareAgent: CloudflareAgentsPlatformAgent;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly payload: CloudflareAgentsFiberPayload;
  readonly resume: CloudflareAgentsResumeRun;
  readonly retry?: CloudflareAgentsRetryFiber;
}

export interface ResumeScheduledCloudflareAgentsFiberOptions
  extends Omit<StartCloudflareAgentsResumeFiberOptions, "payload">,
    CloudflareAgentsPayloadTrustOptions {
  readonly payload: unknown;
}

export interface RecoverCloudflareAgentsFiberOptions
  extends CloudflareAgentsPayloadTrustOptions {
  readonly ctx: CloudflareAgentsFiberRecoveryContext;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly resume: CloudflareAgentsResumeRun;
  readonly retry?: CloudflareAgentsRetryFiber;
}

export async function startCloudflareAgentsResumeFiber({
  cloudflareAgent,
  drain,
  payload,
  retry,
  resume,
}: StartCloudflareAgentsResumeFiberOptions): Promise<CloudflareAgentsStartFiberResult> {
  return await cloudflareAgent.startFiber(
    cloudflareAgentsFiberName(payload),
    async (ctx) => {
      ctx.stash(payload);
      const result = await resumeAndDrain({ drain, payload, retry, resume });
      if (!(result.completed || result.rescheduled)) {
        throw new Error(`PSS Runtime fiber interrupted: ${result.reason}`);
      }
    },
    {
      idempotencyKey: cloudflareAgentsFiberIdempotencyKey(payload),
      metadata: cloudflareAgentsFiberMetadata(payload),
    }
  );
}

export async function resumeScheduledCloudflareAgentsFiber(
  options: ResumeScheduledCloudflareAgentsFiberOptions
): Promise<CloudflareAgentsStartFiberResult> {
  const payload = parseCloudflareAgentsFiberPayload(options.payload);
  if (!payload) {
    return rejectedCloudflareAgentsFiberResult(
      cloudflareAgentsTrustFailureReason()
    );
  }
  if (!(await isCloudflareAgentsPayloadTrusted(payload, options))) {
    return rejectedCloudflareAgentsFiberResult(
      cloudflareAgentsTrustFailureReason()
    );
  }
  return await startCloudflareAgentsResumeFiber({ ...options, payload });
}

export async function recoverCloudflareAgentsFiber({
  ctx,
  drain,
  retry,
  resume,
  ...trust
}: RecoverCloudflareAgentsFiberOptions): Promise<
  CloudflareAgentsFiberRecoveryResult | false
> {
  const snapshotPayload = parseCloudflareAgentsFiberPayload(ctx.snapshot);
  const metadataPayload = parseCloudflareAgentsFiberPayload(ctx.metadata);
  const payload = snapshotPayload ?? metadataPayload;
  if (!payload) {
    return false;
  }
  if (
    snapshotPayload &&
    metadataPayload &&
    !areCloudflareAgentsPayloadsEquivalent(snapshotPayload, metadataPayload)
  ) {
    return false;
  }
  if (!isCloudflareAgentsRecoveryContextTrusted(ctx, payload)) {
    return false;
  }
  if (!(await isCloudflareAgentsPayloadTrusted(payload, trust))) {
    return false;
  }

  const result = await resumeAndDrain({ drain, payload, retry, resume });
  const snapshot = {
    ...cloudflareAgentsFiberMetadata(payload),
    resumed: result.resumed,
    rescheduled: result.rescheduled,
    retryReason: result.reason,
  };
  if (!result.completed) {
    return {
      reason: result.reason,
      snapshot,
      status: "interrupted",
    };
  }
  return {
    snapshot,
    status: "completed",
  };
}

type ResumeAndDrainResult =
  | {
      readonly completed: true;
      readonly reason?: never;
      readonly rescheduled: false;
      readonly resumed: true;
    }
  | {
      readonly completed: false;
      readonly reason: CloudflareAgentsRetryReason;
      readonly rescheduled: boolean;
      readonly resumed: boolean;
    };

async function resumeAndDrain({
  drain,
  payload,
  retry,
  resume,
}: {
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly payload: CloudflareAgentsFiberPayload;
  readonly retry?: CloudflareAgentsRetryFiber;
  readonly resume: CloudflareAgentsResumeRun;
}): Promise<ResumeAndDrainResult> {
  let resumed = false;
  try {
    const turn = await resume(payload);
    if (!turn) {
      return await retryInterrupted({
        payload,
        reason: "not-claimable",
        retry,
        resumed,
      });
    }
    resumed = true;
    const drainResult = await drainAgentTurnWithBudget(turn, drain);
    if (drainResult.stoppedReason) {
      return await retryInterrupted({
        payload,
        reason: drainResult.stoppedReason,
        retry,
        resumed,
      });
    }
    return {
      completed: true,
      rescheduled: false,
      resumed,
    };
  } catch (error) {
    const result = await retryInterrupted({
      payload,
      reason: "error",
      retry,
      resumed,
    });
    if (result.rescheduled) {
      return result;
    }
    throw error;
  }
}

async function retryInterrupted({
  payload,
  reason,
  retry,
  resumed,
}: {
  readonly payload: CloudflareAgentsFiberPayload;
  readonly reason: CloudflareAgentsRetryReason;
  readonly retry?: CloudflareAgentsRetryFiber;
  readonly resumed: boolean;
}): Promise<ResumeAndDrainResult> {
  return {
    completed: false,
    reason,
    rescheduled: retry ? await retry(payload, reason) : false,
    resumed,
  };
}
