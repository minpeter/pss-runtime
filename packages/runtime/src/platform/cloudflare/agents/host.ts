import type { CloudflareHostOptions } from "../host/create-cloudflare-host";
import type { CloudflareAgentsDefaultResumeAgent } from "./types";

/**
 * @deprecated Use {@link CloudflareHostOptions} from
 * `create-cloudflare-host` / platform cloudflare exports.
 */
export type CloudflareAgentsHostOptions<
  TAgent extends
    CloudflareAgentsDefaultResumeAgent = CloudflareAgentsDefaultResumeAgent,
> = CloudflareHostOptions<TAgent>;
