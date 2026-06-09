import { handleTelegramWebhook } from "./telegram";
import type { Env } from "./env";

export { AgentDurableObject } from "./agent-do";
export type { Env } from "./env";

export default {
  fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return handleTelegramWebhook(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;