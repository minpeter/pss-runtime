import { createTRPCClient, httpLink } from "@trpc/client";
import type { WorkerAgentRouter } from "../tui/tui-rpc";
import {
  type ReplayEventsRequest,
  type ReplayEventsResponse,
  ReplayEventsResponseSchema,
  type StoredThreadEvent,
  type SubmitTurnRequest,
  type SubmitTurnResponse,
  SubmitTurnResponseSchema,
  serializeSessionChannel,
  serializeThreadEventCursor,
  type ThreadEventCursor,
} from "./session-contract";

export interface RemoteSessionClient {
  replayEvents(input: ReplayEventsRequest): Promise<ReplayEventsResponse>;
  submitTurn(input: SubmitTurnRequest): Promise<SubmitTurnResponse>;
}

export interface RemoteSessionClientConfig {
  readonly endpoint: string;
  readonly token?: string;
}

export interface RemoteSessionEventStreamConfig {
  readonly after?: ThreadEventCursor;
  readonly channel: SubmitTurnRequest["channel"];
  readonly endpoint: string;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly sessionScopeKey?: string;
  readonly signal?: AbortSignal;
  readonly token?: string;
}

export function createRemoteSessionClient(
  config: RemoteSessionClientConfig
): RemoteSessionClient {
  const client = createTRPCClient<WorkerAgentRouter>({
    links: [
      httpLink({
        headers: () =>
          config.token ? { authorization: `Bearer ${config.token}` } : {},
        url: config.endpoint,
      }),
    ],
  });

  return {
    replayEvents: async (input) => {
      const response: unknown = await client.session.replayEvents.query(input);
      return ReplayEventsResponseSchema.parse(response);
    },
    submitTurn: async (input) => {
      const response: unknown = await client.session.submitTurn.mutate(input);
      return SubmitTurnResponseSchema.parse(response);
    },
  };
}

export async function* streamRemoteSessionEvents(
  config: RemoteSessionEventStreamConfig
): AsyncIterable<StoredThreadEvent> {
  const fetchSessionEvents = config.fetch ?? ((request) => fetch(request));
  let cursor = config.after;

  while (!config.signal?.aborted) {
    const url = new URL(config.endpoint);
    url.searchParams.set("channel", serializeSessionChannel(config.channel));
    if (cursor) {
      url.searchParams.set("after", serializeThreadEventCursor(cursor));
    }
    if (config.sessionScopeKey) {
      url.searchParams.set("sessionScopeKey", config.sessionScopeKey);
    }
    const request = new Request(url, {
      headers: {
        accept: "text/event-stream",
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      ...(config.signal ? { signal: config.signal } : {}),
    });
    const response = await fetchSessionEvents(request);
    if (!response.ok) {
      throw new RemoteSessionEventStreamError(response.status);
    }

    for await (const event of decodeSessionEventStream(response)) {
      cursor = event.cursor;
      yield event;
    }
  }
}

async function* decodeSessionEventStream(
  response: Response
): AsyncIterable<StoredThreadEvent> {
  if (!response.body) {
    throw new RemoteSessionEventStreamError(response.status, "missing body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      buffer += decoder
        .decode(result.value, { stream: true })
        .replaceAll("\r\n", "\n");
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = parseSessionEventFrame(frame);
        if (event) {
          yield event;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseSessionEventFrame(frame: string): StoredThreadEvent | undefined {
  const lines = frame.split("\n");
  if (!lines.includes("event: thread-event")) {
    return;
  }
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) {
    return;
  }
  const parsed: unknown = JSON.parse(data);
  const replay = ReplayEventsResponseSchema.parse({ events: [parsed] });
  const event = replay.events[0];
  if (!event) {
    throw new RemoteSessionEventStreamError(200, "invalid event");
  }
  return event;
}

export class RemoteSessionEventStreamError extends Error {
  constructor(status: number, detail = "request failed") {
    super(`session event stream ${detail}: ${status}`);
    this.name = "RemoteSessionEventStreamError";
  }
}
