import { fetchCloudflareDurableObject } from "@minpeter/pss-runtime/platform/durable-object/cloudflare";

import { type ChannelAddress, channelKey } from "../channel";
import { durableObjectName, type Env } from "../env";
import { isAuthorizedWorkerRequest } from "../rpc/worker-rpc-auth";
import {
  parseSessionChannel,
  parseThreadEventCursor,
  serializeSessionChannel,
} from "./session-contract";

const INTERNAL_SESSION_EVENTS_URL = "https://agent.internal/session/events";

export async function handleSessionEventsRequest(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }
  if (!isAuthorizedWorkerRequest(request, env)) {
    return new Response("unauthorized", { status: 401 });
  }

  const sourceUrl = new URL(request.url);
  const serializedChannel = sourceUrl.searchParams.get("channel");
  if (!serializedChannel) {
    return new Response("channel required", { status: 400 });
  }

  let channel: ChannelAddress;
  try {
    channel = parseSessionChannel(serializedChannel);
    const after = sourceUrl.searchParams.get("after");
    if (after !== null) {
      parseThreadEventCursor(after);
    }
  } catch {
    return new Response("invalid session event stream", { status: 400 });
  }

  const internalUrl = new URL(INTERNAL_SESSION_EVENTS_URL);
  const forwarded = new URLSearchParams();
  forwarded.set("channel", serializeSessionChannel(channel));
  const after = sourceUrl.searchParams.get("after");
  if (after !== null) {
    forwarded.set("after", after);
  }
  // Shared rule: forward sessionScopeKey only when it trims to a non-empty
  // value; a blank key is omitted from the Durable Object request entirely.
  const sessionScopeKey = sourceUrl.searchParams.get("sessionScopeKey")?.trim();
  if (sessionScopeKey) {
    forwarded.set("sessionScopeKey", sessionScopeKey);
  }
  internalUrl.search = forwarded.toString();

  let response: Response | undefined;
  try {
    response = await fetchCloudflareDurableObject({
      namespace: env.AGENT_DO,
      objectName: durableObjectName(channelKey(channel)),
      request: new Request(internalUrl, { method: "GET" }),
    });
  } catch {
    // A rejected stub fetch is an unreachable Durable Object; never surface
    // the underlying stub error (it may carry internal identifiers).
    return new Response("agent durable object unavailable", { status: 502 });
  }
  if (!response?.ok) {
    // The failure is answered before any SSE frame is enqueued, so the
    // client never observes a partial text/event-stream body.
    return new Response("agent durable object unavailable", { status: 502 });
  }
  // Re-assert the documented SSE headers on the outer response: the stub
  // fetch strips hop-by-hop headers such as `connection` from the Durable
  // Object response.
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("connection", "keep-alive");
  headers.set("content-type", "text/event-stream; charset=utf-8");
  return new Response(response.body, { headers, status: response.status });
}
