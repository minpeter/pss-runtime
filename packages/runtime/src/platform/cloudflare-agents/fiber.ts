import { drainAgentTurn } from "../cloudflare";
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
  CloudflareAgentsStartFiberResult,
  CloudflareAgentsTurnDrainOptions,
} from "./types";

export interface StartCloudflareAgentsResumeFiberOptions {
  readonly cloudflareAgent: CloudflareAgentsPlatformAgent;
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly payload: CloudflareAgentsFiberPayload;
  readonly resume: CloudflareAgentsResumeRun;
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
}

export async function startCloudflareAgentsResumeFiber({
  cloudflareAgent,
  drain,
  payload,
  resume,
}: StartCloudflareAgentsResumeFiberOptions): Promise<CloudflareAgentsStartFiberResult> {
  return await cloudflareAgent.startFiber(
    cloudflareAgentsFiberName(payload),
    async (ctx) => {
      ctx.stash(payload);
      await resumeAndDrain({ drain, payload, resume });
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

  const resumed = await resumeAndDrain({ drain, payload, resume });
  return {
    snapshot: {
      ...cloudflareAgentsFiberMetadata(payload),
      resumed,
    },
    status: "completed",
  };
}

async function resumeAndDrain({
  drain,
  payload,
  resume,
}: {
  readonly drain?: CloudflareAgentsTurnDrainOptions;
  readonly payload: CloudflareAgentsFiberPayload;
  readonly resume: CloudflareAgentsResumeRun;
}): Promise<boolean> {
  const turn = await resume(payload);
  if (!turn) {
    return false;
  }
  await drainAgentTurn(turn, drain);
  return true;
}
