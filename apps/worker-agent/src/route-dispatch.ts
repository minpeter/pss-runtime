import { isHealthPathname } from "./health/health";

export const SESSION_EVENTS_PATHNAME = "/session/events";
export const TUI_RPC_PATHNAME = "/trpc";

/** Fetch-handler routes, named after the wide-event `handler` log field. */
export type WorkerRequestHandler =
  | "health"
  | "session-events"
  | "telegram-webhook"
  | "tui-rpc";

/**
 * Pathname-only route table. `/healthz` (+ trailing slash) is health; the
 * exact `/session/events` pathname is the SSE route; `/trpc` and every
 * `/trpc/*` sub-path go to the tRPC fetch adapter; every other pathname —
 * including `/`, `/healthcheck`, `/healthz/foo`, `/session/events/replay`,
 * and `/telegram` — falls through to the Telegram webhook catch-all.
 */
export function selectRequestHandler(pathname: string): WorkerRequestHandler {
  if (isHealthPathname(pathname)) {
    return "health";
  }
  if (pathname === SESSION_EVENTS_PATHNAME) {
    return "session-events";
  }
  if (
    pathname === TUI_RPC_PATHNAME ||
    pathname.startsWith(`${TUI_RPC_PATHNAME}/`)
  ) {
    return "tui-rpc";
  }
  return "telegram-webhook";
}
