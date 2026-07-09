import type { AgentHost } from "../../../execution";
import {
  createCloudflareHost,
  type CloudflareHostAgentsOptions,
} from "../host/create-cloudflare-host";
import type { CloudflareAgentsDefaultResumeAgent } from "./types";

/** @deprecated Use {@link createCloudflareHost} with agents options. */
export type CloudflareAgentsHostOptions<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = CloudflareHostAgentsOptions<TAgent>;

/** @deprecated Use {@link createCloudflareHost} with agents options. */
export function createCloudflareAgentsHost<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
>(options: CloudflareHostAgentsOptions<TAgent>): AgentHost {
  return createCloudflareHost(options);
}
