import { installCloudflareImageCodecs } from "@minpeter/pss-runtime/platform/cloudflare/image-codecs";

import type { Env } from "./env";
import { handleTelegramWebhook } from "./telegram";
import { handleTuiRpcRequest } from "./tui-rpc";

// Edge-first: static wasm modules for AVIF/WebP/HEIC must be installed before
// any attachment staging path runs (Workers cannot fetch/compile wasm at runtime).
installCloudflareImageCodecs();

// biome-ignore lint/performance/noBarrelFile: Wrangler requires Durable Object classes to be exported from the worker entrypoint.
export { AgentDurableObject } from "./agent-do";
export type { Env } from "./env";

const TUI_RPC_PATHNAME = "/trpc";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname === TUI_RPC_PATHNAME ||
      url.pathname.startsWith(`${TUI_RPC_PATHNAME}/`)
    ) {
      return handleTuiRpcRequest(request, env);
    }

    return handleTelegramWebhook(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
