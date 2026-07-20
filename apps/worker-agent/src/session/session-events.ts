import type { StoredThreadEvent } from "@minpeter/pss-runtime";

import {
  type ReplayEventsResponse,
  serializeThreadEventCursor,
  type ThreadEventCursor,
} from "./session-contract";

const SSE_EVENT_NAME = "thread-event";

export interface SessionEventLiveSignal {
  publish(): void;
  subscribe(listener: () => void): () => void;
}

export interface SessionEventStreamOptions {
  readonly after?: ThreadEventCursor;
  readonly live: SessionEventLiveSignal;
  readonly replay: (
    after: ThreadEventCursor | undefined
  ) => Promise<ReplayEventsResponse>;
}

export function createSessionEventLiveSignal(): SessionEventLiveSignal {
  const listeners = new Set<() => void>();
  return {
    publish() {
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createSessionEventStreamResponse({
  after,
  live,
  replay,
}: SessionEventStreamOptions): Response {
  let cancelled = false;
  let stop: (() => void) | undefined;
  let wake: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      stop?.();
      wake?.();
    },
    start(controller) {
      const cursor = after;
      let publishedVersion = 0;
      let observedVersion = 0;
      stop = live.subscribe(() => {
        publishedVersion += 1;
        const resolve = wake;
        wake = undefined;
        resolve?.();
      });

      const waitForPublish = async (): Promise<void> => {
        if (publishedVersion === observedVersion) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        observedVersion = publishedVersion;
      };

      pumpSessionEventStream({
        after: cursor,
        controller,
        isCancelled: () => cancelled,
        replay,
        waitForPublish,
      }).catch((error: unknown) => {
        stop?.();
        controller.error(error);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}

async function pumpSessionEventStream({
  after,
  controller,
  isCancelled,
  replay,
  waitForPublish,
}: {
  readonly after: ThreadEventCursor | undefined;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  readonly isCancelled: () => boolean;
  readonly replay: SessionEventStreamOptions["replay"];
  readonly waitForPublish: () => Promise<void>;
}): Promise<void> {
  let cursor = after;
  while (!isCancelled()) {
    const page = await replay(cursor);
    if (isCancelled()) {
      return;
    }
    for (const event of page.events) {
      controller.enqueue(encodeSseEvent(event));
      cursor = event.cursor;
    }
    cursor = page.nextCursor ?? cursor;
    if (page.events.length === 0) {
      await waitForPublish();
    }
  }
}

function encodeSseEvent(event: StoredThreadEvent): Uint8Array {
  const id = serializeThreadEventCursor(event.cursor);
  return new TextEncoder().encode(
    `id: ${id}\nevent: ${SSE_EVENT_NAME}\ndata: ${JSON.stringify(event)}\n\n`
  );
}
