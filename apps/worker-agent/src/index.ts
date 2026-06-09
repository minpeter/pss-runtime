import type { Env } from "./env";
import { handleTelegramWebhook } from "./telegram";

// biome-ignore lint/performance/noBarrelFile: Wrangler requires Durable Object classes to be exported from the worker entrypoint.
export { AgentDurableObject } from "./agent-do";
export type { Env } from "./env";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleTelegramWebhook(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
