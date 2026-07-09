import { installCloudflareImageCodecs } from "@minpeter/pss-runtime/platform/cloudflare/image-codecs";
import { defineWorkerFetch } from "evlog/workers";

import type { Env } from "./env";
import { handleTelegramWebhook } from "./telegram";
import { handleTuiRpcRequest } from "./tui-rpc";
import { ensureWorkerLogger, newCorrelationId } from "./worker-log";

// Edge-first: static wasm for AVIF/WebP/HEIC before any attachment staging.
installCloudflareImageCodecs();

// biome-ignore lint/performance/noBarrelFile: Wrangler requires Durable Object classes to be exported from the worker entrypoint.
export { AgentDurableObject } from "./agent-do";
export type { Env } from "./env";

const TUI_RPC_PATHNAME = "/trpc";

export default defineWorkerFetch<Env>(async (request, env, ctx, log) => {
  ensureWorkerLogger({
    environment: env.ENVIRONMENT,
    version: env.CF_VERSION_METADATA?.id,
  });
  const url = new URL(request.url);
  const correlationId = newCorrelationId();
  const handler =
    url.pathname === TUI_RPC_PATHNAME ||
    url.pathname.startsWith(`${TUI_RPC_PATHNAME}/`)
      ? "tui-rpc"
      : "telegram-webhook";

  log.set({
    correlationId,
    handler,
    method: request.method,
    path: url.pathname,
  });

  try {
    const response =
      handler === "tui-rpc"
        ? await handleTuiRpcRequest(request, env)
        : await handleTelegramWebhook(request, env, ctx as ExecutionContext, {
            correlationId,
          });

    log.set({ status: response.status });
    log.emit({ status: response.status });
    return response;
  } catch (error) {
    log.error(error instanceof Error ? error : new Error(String(error)));
    log.emit({ status: 500 });
    throw error;
  }
});
