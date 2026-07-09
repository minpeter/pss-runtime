import { installCloudflareImageCodecs } from "@minpeter/pss-runtime/platform/cloudflare/image-codecs";
import { defineWorkerFetch } from "evlog/workers";

import type { Env } from "./env";
import { handleTelegramWebhook } from "./telegram";
import { handleTuiRpcRequest } from "./tui-rpc";
import { ensureWorkerLogger } from "./worker-log";

// Edge-first: static wasm modules for AVIF/WebP/HEIC must be installed before
// any attachment staging path runs (Workers cannot fetch/compile wasm at runtime).
installCloudflareImageCodecs();
ensureWorkerLogger();

// biome-ignore lint/performance/noBarrelFile: Wrangler requires Durable Object classes to be exported from the worker entrypoint.
export { AgentDurableObject } from "./agent-do";
export type { Env } from "./env";

const TUI_RPC_PATHNAME = "/trpc";

export default defineWorkerFetch<Env>(async (request, env, ctx, log) => {
  const url = new URL(request.url);
  const handler =
    url.pathname === TUI_RPC_PATHNAME ||
    url.pathname.startsWith(`${TUI_RPC_PATHNAME}/`)
      ? "tui-rpc"
      : "telegram-webhook";

  log.set({
    handler,
    method: request.method,
    path: url.pathname,
  });

  try {
    const response =
      handler === "tui-rpc"
        ? await handleTuiRpcRequest(request, env)
        : await handleTelegramWebhook(request, env, ctx as ExecutionContext);

    log.set({ status: response.status });
    log.emit({ status: response.status });
    return response;
  } catch (error) {
    log.error(error instanceof Error ? error : new Error(String(error)));
    log.emit({ status: 500 });
    throw error;
  }
});
